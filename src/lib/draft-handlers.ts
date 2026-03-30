'use strict'

import cds = require('@sap/cds')
import * as presence from './presence'
import * as fieldLocks from './field-locks'
import * as merge from './merge'

const LOG = cds.log('collab-draft')

interface UserInfo {
  id?: string
  name?: string
}

/**
 * Emits a WebSocket side-effect event.
 */
async function emitCollabEvent(
  eventName: string,
  entitySetName: string,
  entityID: string,
  userInfo?: UserInfo
): Promise<void> {
  try {
    const wsService = await (cds.connect.to('CollabDraftWebSocketService') as Promise<any>).catch(() => null)
    if (!wsService) return
    const sideEffectSource = `/${entitySetName}(ID=${encodeURIComponent(entityID)},IsActiveEntity=false)`
    await wsService.emit(eventName, {
      ID: entityID,
      IsActiveEntity: false,
      serverAction: 'RaiseSideEffect',
      sideEffectSource,
      sideEffectEventName: eventName,
      userID: userInfo?.id || 'unknown',
      userDescription: userInfo?.name || userInfo?.id || 'Unknown User'
    })
    LOG.debug(`Emitted ${eventName} for ${entitySetName}(${entityID}) by ${userInfo?.id || '?'}`)
  } catch (err: any) {
    LOG.debug(`WS emit skipped: ${err.message}`)
  }
}

/**
 * Derives the OData entity set name (short name) from a target entity name or request.
 */
function _entitySetName(req: any): string {
  const name: string = req.target?.actives?.name ?? req.target?.name ?? 'Unknown'
  const parts = name.split('.')
  const short = parts[parts.length - 1]
  if (short === 'drafts' && parts.length > 1) {
    return parts[parts.length - 2]
  }
  return short
}

/**
 * Returns all service entities that have @CollaborativeDraft.enabled
 */
export function getCollaborativeEntities(srv: any): Set<string> {
  const result = new Set<string>()
  for (const [name, entity] of Object.entries<any>(srv.entities || {})) {
    if (entity?.['@CollaborativeDraft.enabled'] === true && entity?.['@odata.draft.enabled'] === true) {
      result.add(name)
    }
  }
  return result
}

/**
 * Returns all entities in the composition subtree of collaborative draft entities.
 */
function getCollaborativeSubtree(srv: any, collaborativeEntities: Set<string>): Set<string> {
  const subtree = new Set<string>(collaborativeEntities)
  const visited = new Set<string>()

  function walkCompositions(entityDef: any): void {
    if (!entityDef || visited.has(entityDef.name)) return
    visited.add(entityDef.name)
    const comps = entityDef.compositions || {}
    for (const comp of Object.values<any>(comps)) {
      const target = comp._target
      if (!target) continue
      for (const [shortName, e] of Object.entries<any>(srv.entities || {})) {
        if ((e as any).name === target.name) { subtree.add(shortName); break }
      }
      walkCompositions(target)
    }
  }

  for (const entityName of collaborativeEntities) {
    const entity = srv.entities[entityName]
    if (entity) walkCompositions(entity)
  }
  return subtree
}

/**
 * Checks if the request target is a collaborative draft entity
 */
function isCollaborativeTarget(req: any, collaborativeEntities: Set<string>): boolean {
  const targetName: string | undefined = req.target?.actives?.name ?? req.target?.name
  for (const name of collaborativeEntities) {
    if (targetName === name || targetName?.endsWith('.' + name.split('.').pop())) {
      return true
    }
  }
  return false
}

/**
 * Gets user display name from request context
 */
function getUserDisplayName(req: any): string {
  const id: string | undefined = req.user?.id
  if (!id) return 'Unknown'
  const mockedUsers: Record<string, any> = (cds.env as any)?.requires?.auth?.users ?? {}
  if (mockedUsers[id]?.displayName) return mockedUsers[id].displayName
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Registers collaborative draft handlers on a service.
 * Must be called inside srv.prepend() to run before lean-draft handlers.
 */
export function registerHandlers(srv: any, collaborativeEntities: Set<string>): void {
  const collaborativeSubtree = getCollaborativeSubtree(srv, collaborativeEntities)

  //
  // ── srv.handle wrapper — pre-update InProcessByUser before lean_draft's lock check ──
  //
  const _origHandle = srv.handle.bind(srv)
  srv.handle = async function collabDraftHandle(req: any) {
    let _collabDraftUUID: string | null = null
    const keyObj = req.params?.[0]
    const isForDraft = keyObj?.IsActiveEntity === false
    const entityID: string | null = isForDraft ? (keyObj?.ID ?? null) : null

    if (isForDraft && entityID && isCollaborativeTarget(req, collaborativeSubtree)) {
      try {
        const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
        if (draftUUID && await _isDraftCollaborative(draftUUID)) {
          await (cds.db as any).run(
            'UPDATE DRAFT_DraftAdministrativeData SET InProcessByUser = ? WHERE DraftUUID = ?',
            [req.user.id, draftUUID]
          )
          _collabDraftUUID = draftUUID
          LOG.debug(`Pre-set InProcessByUser=${req.user.id} for collab draft ${draftUUID} (event: ${req.event})`)
        }
      } catch (err: any) {
        LOG.debug('Could not pre-set InProcessByUser:', err.message)
      }
    }

    let result: any
    try {
      result = await _origHandle(req)
    } catch (err: any) {
      if (err.code === '404' && req.event === 'READ' &&
          isCollaborativeTarget(req, collaborativeSubtree) &&
          req.params?.[0]?.IsActiveEntity === false) {
        LOG.debug(`Suppressed 404 for draft READ after activation: ${req.params?.[0]?.ID}`)
        return null
      }
      throw err
    }

    // Emit CollaborativeDraftChanged for child entity mutations in a collaborative draft.
    if (_collabDraftUUID && result != null &&
        !isCollaborativeTarget(req, collaborativeEntities) &&
        req.event !== 'READ') {
      const rootCtx = await _resolveCollabRootContext(_collabDraftUUID, srv, collaborativeEntities).catch(() => null)
      if (rootCtx) {
        emitCollabEvent('CollaborativeDraftChanged', rootCtx.entitySetName, rootCtx.entityID,
          { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
      }
    }

    return result
  }

  //
  // ── EDIT handler ──────────────────────────────────────────────────────────────
  //
  srv.on('EDIT', '*', async function onCollaborativeEdit(req: any, next: () => Promise<any>) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return next()

    const target = req.target?.actives ?? req.target
    if (!target || target.isDraft) return next()

    LOG.debug(`EDIT request from ${req.user.id} on ${target.name}`)

    try {
      const draftsTarget = target.drafts
      if (!draftsTarget) return next()

      const where = req.query?.SELECT?.from?.ref?.[0]?.where ?? req.params?.[0]
      if (!where) return next()

      const draftRow = await cds.run(
        SELECT.one
          .from(draftsTarget)
          .columns(['DraftAdministrativeData_DraftUUID', 'IsActiveEntity'])
          .where(Array.isArray(where) ? where : [where])
      )

      if (!draftRow) {
        LOG.debug(`No existing draft found — creating new draft for ${req.user.id}`)
        return next()
      }

      const draftUUID: string = draftRow.DraftAdministrativeData_DraftUUID
      LOG.debug(`User ${req.user.id} joining existing draft ${draftUUID}`)

      let isOrig = false
      try {
        const adminRows: any = await (cds.db as any).run(
          `SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
          [draftUUID]
        )
        const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser
        isOrig = createdBy === req.user.id
      } catch {}

      await presence.join(draftUUID, req.user.id, {
        displayName: getUserDisplayName(req),
        isOriginator: isOrig
      })

      const draftData: any = await cds.run(
        SELECT.one.from(draftsTarget).where(Array.isArray(where) ? where : [where])
      )

      if (!draftData) return next()

      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: '' })
          .where({ DraftUUID: draftUUID })
      )

      draftData.IsActiveEntity = false
      draftData.HasActiveEntity = true

      if (req.res) {
        req.res.status(200)
      }

      return draftData
    } catch (err: any) {
      LOG.error('Error in EDIT handler:', err.message)
      return next()
    }
  })

  //
  // ── after EDIT hook — register originator ─────────────────────────────────────
  //
  srv.after('EDIT', '*', async function afterCollaborativeEdit(result: any, req: any) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return
    if (!result) return

    let draftUUID: string | undefined = result?.DraftAdministrativeData_DraftUUID

    if (!draftUUID && result?.ID) {
      const target = req.target?.actives?.drafts ?? req.target?.drafts
      if (target) {
        try {
          const row: any = await cds.run(
            SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: result.ID })
          )
          draftUUID = row?.DraftAdministrativeData_DraftUUID
        } catch (err: any) {
          LOG.debug('Could not look up DraftUUID after EDIT:', err.message)
        }
      }
    }

    if (!draftUUID) return

    if (!presence.isParticipant(draftUUID, req.user.id)) {
      LOG.debug(`Registering ${req.user.id} as originator of draft ${draftUUID}`)
      await presence.join(draftUUID, req.user.id, {
        displayName: getUserDisplayName(req),
        isOriginator: true
      })
    }

    try {
      await (cds.db as any).run(
        'UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?',
        ['S', draftUUID]
      )
    } catch (err: any) {
      LOG.debug('Could not set DraftAccessType:', err.message)
    }
  })

  //
  // ── before UPDATE (PATCH) — field-level locking ───────────────────────────────────────
  //
  srv.before('UPDATE', '*', async function onCollaborativePatch(req: any) {
    if (!isCollaborativeTarget(req, collaborativeSubtree)) return

    const keyObj = req.params?.[0]
    if (!keyObj || typeof keyObj !== 'object') return
    if (keyObj.IsActiveEntity !== false) return

    const target = req.target

    try {
      const patchedFields = fieldLocks.extractPatchedFields(req.data)
      if (patchedFields.length === 0) return

      const entityID: string | undefined = keyObj.ID
      if (!entityID) return

      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      const entityName: string = target.name
      const entityKey = fieldLocks.serializeEntityKey(req)

      const isCollab = await _isDraftCollaborative(draftUUID)
      if (!isCollab) return

      await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req))

      const { acquired, conflicts } = await fieldLocks.acquireLocks({
        draftUUID,
        entityName,
        entityKey,
        fieldNames: patchedFields,
        userID: req.user.id
      })

      if (!acquired && conflicts.length > 0) {
        const conflictMsg = conflicts
          .map(c => `"${c.fieldName}" (locked by ${c.lockedBy})`)
          .join(', ')
        req.error(409, `Field lock conflict: ${conflictMsg}. Please try again.`)
        return
      }
    } catch (err: any) {
      LOG.error('Error in PATCH handler:', err.message)
    }
  })

  //
  // ── after UPDATE (PATCH) — emit CollaborativeDraftChanged ──────────────────────
  //
  srv.after('UPDATE', '*', async function afterCollaborativePatch(result: any, req: any) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return
    const keyObj = req.params?.[0]
    if (!keyObj || typeof keyObj !== 'object') return
    if (keyObj.IsActiveEntity !== false || !keyObj.ID) return
    emitCollabEvent('CollaborativeDraftChanged', _entitySetName(req), keyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
  })

  //
  // ── before draftPrepare — cross-participant validation ────────────────────────
  //
  srv.before('draftPrepare', '*', async function onCollaborativePrepare(req: any) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    try {
      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      const { valid, issues } = await merge.validateBeforeActivation(draftUUID)
      if (!valid) {
        LOG.warn(`Draft ${draftUUID} has consistency issues:`, issues)
      }

      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: req.user.id })
          .where({ DraftUUID: draftUUID })
      )
    } catch (err: any) {
      LOG.error('Error in draftPrepare handler:', err.message)
    }
  })

  //
  // ── before draftActivate ──────────────────────────────────────────────────────
  //
  srv.before('draftActivate', '*', async function onCollaborativeActivate(req: any) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    try {
      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      LOG.debug(`User ${req.user.id} activating collaborative draft ${draftUUID}`)

      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: req.user.id })
          .where({ DraftUUID: draftUUID })
      )
    } catch (err: any) {
      LOG.error('Error in draftActivate before handler:', err.message)
    }
  })

  //
  // ── after draftActivate — cleanup ────────────────────────────────────────────
  //
  srv.after('draftActivate', '*', async function afterCollaborativeActivate(result: any, req: any) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    LOG.debug('Draft activated — cleaning up collaborative artifacts')

    const draftUUID: string | undefined = req._collabDraftUUID
    if (draftUUID) {
      await merge.cleanup(draftUUID)
    }

    const entityID: string | undefined = req._collabEntityID ?? req.params?.[0]?.ID ?? result?.ID
    if (entityID) {
      emitCollabEvent('CollaborativePresenceChanged', _entitySetName(req), entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
    }
  })

  //
  // ── on CANCEL / DELETE ────────────────────────────────────────────────────────
  //
  srv.on('CANCEL', '*', async function onCollaborativeCancel(req: any, next: () => Promise<any>) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return next()

    try {
      const target = req.target?.isDraft ? req.target : req.target?.drafts
      if (!target) return next()

      const where = req.query?.DELETE?.from?.ref?.[0]?.where ?? req.params?.[0]
      if (!where) return next()

      const row: any = await cds.run(
        SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where(
          Array.isArray(where) ? where : [where]
        )
      )

      if (!row?.DraftAdministrativeData_DraftUUID) return next()

      const draftUUID: string = row.DraftAdministrativeData_DraftUUID

      let isOrig = false
      try {
        const adminRows: any = await (cds.db as any).run(
          `SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
          [draftUUID]
        )
        const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser
        isOrig = createdBy === req.user.id
      } catch (err: any) {
        LOG.debug('Could not look up CreatedByUser for CANCEL:', err.message)
        isOrig = presence.isOriginator(draftUUID, req.user.id)
      }

      if (isOrig) {
        LOG.debug(`Originator ${req.user.id} cancelling draft ${draftUUID} — removing all participants`)
        await merge.cleanup(draftUUID)
        return next()
      } else {
        LOG.debug(`Participant ${req.user.id} leaving draft ${draftUUID}`)
        await presence.leave(draftUUID, req.user.id)
        await fieldLocks.releaseLocks(draftUUID, req.user.id)

        const entityID: string | undefined = (Array.isArray(req.params?.[0]) ? undefined : req.params?.[0]?.ID) ??
          req.query?.DELETE?.from?.ref?.[0]?.where?.find?.((w: any) => w?.ref?.[0] === 'ID' && w?.val)?.val
        const entitySetName = _entitySetName(req)
        if (entityID) {
          emitCollabEvent('CollaborativePresenceChanged', entitySetName, entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
        }

        return null
      }
    } catch (err: any) {
      LOG.error('Error in CANCEL handler:', err.message)
      return next()
    }
  })

  //
  // ── after READ on DraftAdministrativeData — inject collaborative draft fields ──
  //
  srv.after('READ', 'DraftAdministrativeData', async function afterReadDraftAdmin(result: any, req: any) {
    if (!result) return

    const results: any[] = Array.isArray(result) ? result : [result]
    for (const row of results) {
      if (!row?.DraftUUID) continue

      const draftUUID: string = row.DraftUUID

      if (!row.CollaborativeDraftEnabled) {
        const isCollab = row.DraftAccessType === 'S' || presence.getParticipants(draftUUID).length > 0
        row.CollaborativeDraftEnabled = isCollab
      }

      if (row.InProcessByUser === null || row.InProcessByUser === undefined) row.InProcessByUser = ''
      if (row.CreatedByUser === null || row.CreatedByUser === undefined) row.CreatedByUser = ''
      if (row.LastChangedByUser === null || row.LastChangedByUser === undefined) row.LastChangedByUser = ''
    }
  })

  //
  // ── READ on DraftAdministrativeUser — serve participants ─────────────────────
  //
  srv.on('READ', 'DraftAdministrativeUser', async function onReadDraftAdminUser(req: any) {
    let draftUUID: string | null = null

    if (req.params?.length) {
      for (const p of req.params) {
        if (p?.DraftUUID) { draftUUID = p.DraftUUID; break }
      }
    }

    if (!draftUUID) {
      const where: any[] | undefined = req.query?.SELECT?.where
      if (Array.isArray(where)) {
        for (let i = 0; i < where.length - 2; i++) {
          if (where[i]?.ref?.[0] === 'DraftUUID' && where[i + 2]?.val) {
            draftUUID = where[i + 2].val
            break
          }
        }
      }
    }

    if (!draftUUID) {
      const entityID: string | undefined = req.params?.find((p: any) => p?.ID)?.ID
      if (entityID) {
        for (const entityName of collaborativeEntities) {
          const entity = srv.entities[entityName]
          if (!entity?.drafts) continue
          try {
            const row: any = await cds.run(
              SELECT.one.from(entity.drafts).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID })
            )
            if (row?.DraftAdministrativeData_DraftUUID) {
              draftUUID = row.DraftAdministrativeData_DraftUUID
              break
            }
          } catch (_err) { /* try next entity */ }
        }
      }
    }

    if (!draftUUID) {
      LOG.debug('DraftAdministrativeUser READ: could not resolve DraftUUID from request')
      return []
    }

    const excludeUserIDs = new Set<string>()
    const where: any[] | undefined = req.query?.SELECT?.where
    if (Array.isArray(where)) {
      for (let i = 0; i < where.length - 2; i++) {
        if (where[i]?.ref?.[0] === 'UserID' && (where[i + 1] === 'ne' || where[i + 1] === '!=') && where[i + 2]?.val) {
          excludeUserIDs.add(where[i + 2].val)
        }
      }
    }

    const mockedUsers: Record<string, any> = (cds.env as any)?.requires?.auth?.users ?? {}

    const inMemory = presence.getParticipants(draftUUID)
    if (inMemory.length > 0) {
      return inMemory
        .filter(p => !excludeUserIDs.has(p.userID))
        .map(p => ({
          DraftUUID: draftUUID,
          UserID: p.userID || 'unknown',
          UserDescription: mockedUsers[p.userID]?.displayName || p.displayName || p.userID || 'Unknown User',
          UserEditingState: 'P'
        }))
    }

    try {
      const rows: any[] = await cds.run(
        SELECT.from('DRAFT.DraftParticipants')
          .columns(['UserID', 'UserDescription', 'IsOriginator'])
          .where({ DraftUUID: draftUUID })
      )
      if (rows.length > 0) {
        for (const r of rows) {
          presence.join(draftUUID, r.UserID, {
            displayName: r.UserDescription || r.UserID,
            isOriginator: r.IsOriginator === true || r.IsOriginator === 1
          }).catch(() => {})
        }
        return rows
          .filter(r => !excludeUserIDs.has(r.UserID))
          .map(r => ({
            DraftUUID: draftUUID,
            UserID: r.UserID || 'unknown',
            UserDescription: r.UserDescription || r.UserID || 'Unknown User',
            UserEditingState: 'P'
          }))
      }
    } catch (err: any) {
      LOG.debug('Could not load DraftAdministrativeUser from DB:', err.message)
    }

    return []
  })

  //
  // ── ColDraftShare bound actions — participant self-registration ───────────────
  //
  for (const entityName of collaborativeEntities) {
    const shortName = entityName.split('.').pop()!
    const actionName = `${shortName}_ColDraftShare`

    srv.on(actionName, async function onColDraftShare(req: any) {
      let draftUUID: string | null = req.data?.DraftUUID ?? null

      if (!draftUUID) {
        const keyObj = req.params?.[0]
        if (keyObj && typeof keyObj === 'object') {
          const draftsTarget = req.target?.drafts ?? req.target?.actives?.drafts
          if (draftsTarget) {
            try {
              const whereObj = Object.fromEntries(
                Object.entries(keyObj).filter(([k]) => k !== 'IsActiveEntity')
              )
              const draftRow: any = await cds.run(
                SELECT.one
                  .from(draftsTarget)
                  .columns(['DraftAdministrativeData_DraftUUID'])
                  .where(whereObj)
              )
              draftUUID = draftRow?.DraftAdministrativeData_DraftUUID ?? null
            } catch (err: any) {
              LOG.debug(`${actionName}: could not look up DraftUUID:`, err.message)
            }
          }
        }
      }

      if (!draftUUID) {
        LOG.debug(`${actionName} called without DraftUUID — ignoring`)
        return
      }

      LOG.debug(`${actionName}: user ${req.user.id} joining draft ${draftUUID}`)

      try {
        if (!presence.isParticipant(draftUUID, req.user.id)) {
          await presence.join(draftUUID, req.user.id, {
            displayName: getUserDisplayName(req),
            isOriginator: false
          })
        } else {
          await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req))
        }

        await cds.run(
          UPDATE('DRAFT.DraftAdministrativeData')
            .data({ InProcessByUser: '' })
            .where({ DraftUUID: draftUUID })
        )
        try {
          await (cds.db as any).run(
            'UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?',
            ['S', draftUUID]
          )
        } catch (err: any) {
          LOG.debug('Could not set DraftAccessType in ColDraftShare:', err.message)
        }

        const entityKeyObj = req.params?.[0]
        if (entityKeyObj?.ID) {
          emitCollabEvent('CollaborativePresenceChanged', shortName, entityKeyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})

          try {
            const wsService: any = await (cds.connect.to('CollabDraftWebSocketService') as Promise<any>).catch(() => null)
            if (wsService) {
              const displayName = getUserDisplayName(req)
              const clientContent = `/${shortName}(ID=${entityKeyObj.ID},IsActiveEntity=false)`

              await wsService.emit('message', {
                userAction: 'JOIN',
                clientAction: 'JOIN',
                clientContent,
                clientTriggeredActionName: '',
                clientRefreshListBinding: '',
                clientRequestedProperties: '',
                userID: req.user.id,
                userDescription: displayName
              })

              const participants = presence.getParticipants(draftUUID)
              const _mockedUsers: Record<string, any> = (cds.env as any)?.requires?.auth?.users ?? {}
              for (const p of participants) {
                if (p.userID === req.user.id) continue
                const pName = _mockedUsers[p.userID]?.displayName || p.displayName || p.userID
                await wsService.emit('message', {
                  userAction: 'JOINECHO',
                  clientAction: 'JOINECHO',
                  clientContent,
                  clientTriggeredActionName: '',
                  clientRefreshListBinding: '',
                  clientRequestedProperties: '',
                  userID: p.userID,
                  userDescription: pName
                })
              }
            }
          } catch (err: any) {
            LOG.debug('WS JOIN emit failed:', err.message)
          }
        }
      } catch (err: any) {
        LOG.error(`Error in ${actionName}:`, err.message)
      }
    })

    LOG.debug(`Registered ${actionName} handler for ${entityName}`)
  }

  LOG.debug(`Collaborative draft handlers registered for service ${srv.name}`)
}

/**
 * Checks if a draft UUID has collaborative draft enabled.
 */
async function _isDraftCollaborative(draftUUID: string): Promise<boolean> {
  try {
    const rows: any = await (cds.db as any).run(
      `SELECT DraftAccessType FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
      [draftUUID]
    )
    const accessType = Array.isArray(rows) ? rows[0]?.DraftAccessType : rows?.DraftAccessType
    if (accessType === 'S') return true
  } catch (_err) { /* fall through */ }

  if (presence.getParticipants(draftUUID).length > 0) return true
  try {
    const row = await cds.run(SELECT.one.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID }))
    return !!row
  } catch (_err) {
    return false
  }
}

/**
 * Given a DraftUUID, resolves the root collaborative entity's ID and OData entity set name.
 */
async function _resolveCollabRootContext(
  draftUUID: string,
  srv: any,
  collaborativeEntities: Set<string>
): Promise<{ entitySetName: string; entityID: string } | null> {
  for (const entityName of collaborativeEntities) {
    const entity = srv.entities?.[entityName]
    if (!entity) continue
    const draftsTarget = entity.drafts ?? entity
    try {
      const row: any = await cds.run(
        SELECT.one.from(draftsTarget)
          .columns(['ID'])
          .where({ DraftAdministrativeData_DraftUUID: draftUUID })
      )
      if (row?.ID) {
        return { entitySetName: entityName.split('.').pop()!, entityID: row.ID }
      }
    } catch (_err) { /* try next */ }
  }
  return null
}

/**
 * Looks up DraftUUID for the entity referenced in a request.
 */
async function _lookupDraftUUID(
  req: any,
  srv: any,
  collaborativeEntities: Set<string>
): Promise<string | null> {
  const keyObj = req.params?.[0]
  if (!keyObj || typeof keyObj !== 'object') return null

  const entityID: string | undefined = keyObj.ID
  if (!entityID) return null

  const candidates: any[] = [
    req.target?.drafts,
    req.target?.actives?.drafts,
    req.target
  ]

  for (const target of candidates) {
    if (!target) continue
    try {
      const row: any = await cds.run(
        SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID })
      )
      if (row?.DraftAdministrativeData_DraftUUID) return row.DraftAdministrativeData_DraftUUID
    } catch (_err) { /* try next candidate */ }
  }

  for (const entityName of collaborativeEntities) {
    const entity = srv.entities?.[entityName]
    if (!entity) continue
    for (const target of [entity.drafts, entity]) {
      if (!target) continue
      try {
        const row: any = await cds.run(
          SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID })
        )
        if (row?.DraftAdministrativeData_DraftUUID) return row.DraftAdministrativeData_DraftUUID
      } catch (_err) { /* try next */ }
    }
  }

  return null
}
