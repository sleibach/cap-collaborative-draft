'use strict'

const cds = require('@sap/cds')
const LOG = cds.log('collab-draft')
const presence = require('./presence')
const fieldLocks = require('./field-locks')
const merge = require('./merge')

/**
 * Emits a WebSocket side-effect event.
 * Uses CollabDraftWebSocketService if available (requires @cap-js-community/websocket
 * to be installed in the consumer app). Silently skips if the service is not connected.
 *
 * @param {string} eventName - 'CollaborativePresenceChanged' | 'CollaborativeDraftChanged'
 * @param {string} entitySetName - OData collection name, e.g. 'Orders'
 * @param {string} entityID - UUID of the entity
 */
async function emitCollabEvent(eventName, entitySetName, entityID, userInfo) {
  try {
    const wsService = await cds.connect.to('CollabDraftWebSocketService').catch(() => null)
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
    LOG.debug(`[collab-draft] Emitted ${eventName} for ${entitySetName}(${entityID}) by ${userInfo?.id || '?'}`)
  } catch (err) {
    LOG.debug(`[collab-draft] WS emit skipped: ${err.message}`)
  }
}

/**
 * Derives the OData entity set name (short name) from a target entity name or request.
 * @param {object} req
 * @returns {string}
 */
function _entitySetName(req) {
  // In lean_draft mode, req.target is the .drafts entity (e.g. OrderService.Orders.drafts)
  // req.target.actives is the real entity (e.g. OrderService.Orders)
  const name = req.target?.actives?.name ?? req.target?.name ?? 'Unknown'
  const parts = name.split('.')
  const short = parts[parts.length - 1]
  // Defensive: if actives wasn't set and the name ends in 'drafts', strip it
  if (short === 'drafts' && parts.length > 1) {
    return parts[parts.length - 2]
  }
  return short
}

/**
 * Returns all service entities that have @CollaborativeDraft.enabled
 * @param {object} srv - ApplicationService instance
 * @returns {Set<string>} entity names (fully qualified, as in srv.entities)
 */
function getCollaborativeEntities(srv) {
  const result = new Set()
  for (const [name, entity] of Object.entries(srv.entities || {})) {
    if (entity?.['@CollaborativeDraft.enabled'] === true && entity?.['@odata.draft.enabled'] === true) {
      result.add(name)
    }
  }
  return result
}

/**
 * Checks if the request target is a collaborative draft entity
 * @param {object} req
 * @param {Set<string>} collaborativeEntities
 * @returns {boolean}
 */
function isCollaborativeTarget(req, collaborativeEntities) {
  const targetName = req.target?.actives?.name ?? req.target?.name
  // Match by short name or full name
  for (const name of collaborativeEntities) {
    if (targetName === name || targetName?.endsWith('.' + name.split('.').pop())) {
      return true
    }
  }
  return false
}

/**
 * Gets user display name from request context
 * @param {object} req
 * @returns {string}
 */
function getUserDisplayName(req) {
  return req.user?.name || req.user?.id || 'Unknown'
}

/**
 * Registers collaborative draft handlers on a service.
 * Must be called inside srv.prepend() to run before lean-draft handlers.
 *
 * @param {object} srv - ApplicationService instance
 * @param {Set<string>} collaborativeEntities
 */
function registerHandlers(srv, collaborativeEntities) {
  //
  // ── srv.handle wrapper — pre-update InProcessByUser before lean_draft's lock check ──
  //
  // lean_draft overrides srv.handle (= draftHandle) and checks InProcessByUser BEFORE
  // calling the normal handler chain. This means a srv.before('PATCH') handler runs too
  // late to update InProcessByUser in time. We wrap srv.handle so our update runs first.
  //
  const _origHandle = srv.handle.bind(srv)
  srv.handle = async function collabDraftHandle(req) {
    // For collaborative draft entities with IsActiveEntity=false, lean_draft checks
    // InProcessByUser BEFORE running the handler chain (for both PATCH/UPDATE and bound actions).
    // We pre-set InProcessByUser = currentUser before calling lean_draft so its check passes.
    //
    // Applies to: UPDATE (PATCH), custom bound actions (e.g. Orders_ColDraftShare), and
    // READ events (lean_draft adds WHERE InProcessByUser = currentUser to draft reads).
    if (isCollaborativeTarget(req, collaborativeEntities)) {
      const keyObj = req.params?.[0]
      const isForDraft = keyObj?.IsActiveEntity === false
      const entityID = isForDraft ? (keyObj?.ID ?? null) : null

      if (isForDraft && entityID) {
        try {
          const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
          if (draftUUID && await _isDraftCollaborative(draftUUID)) {
            await cds.db.run(
              'UPDATE DRAFT_DraftAdministrativeData SET InProcessByUser = ? WHERE DraftUUID = ?',
              [req.user.id, draftUUID]
            )
            LOG.debug(`[collab-draft] Pre-set InProcessByUser=${req.user.id} for collab draft ${draftUUID} (event: ${req.event})`)
          }
        } catch (err) {
          LOG.debug('[collab-draft] Could not pre-set InProcessByUser:', err.message)
        }
      }
    }
    try {
      return await _origHandle(req)
    } catch (err) {
      // After draftActivate, the draft row is deleted. Other users' browsers may still
      // try to READ the draft entity (IsActiveEntity=false) and get 404. Suppress this
      // for collaborative draft READs — the FE recovers by navigating to the active entity.
      if (err.code === '404' && req.event === 'READ' &&
          isCollaborativeTarget(req, collaborativeEntities) &&
          req.params?.[0]?.IsActiveEntity === false) {
        LOG.debug(`[collab-draft] Suppressed 404 for draft READ after activation: ${req.params?.[0]?.ID}`)
        return null
      }
      throw err
    }
  }

  //
  // ── EDIT handler ──────────────────────────────────────────────────────────────
  // For collaborative draft: if a draft already exists, JOIN it instead of rejecting
  //
  srv.on('EDIT', '*', async function onCollaborativeEdit(req, next) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return next()

    const target = req.target?.actives ?? req.target
    if (!target || target.isDraft) return next()

    LOG.debug(`[collab-draft] EDIT request from ${req.user.id} on ${target.name}`)

    try {
      // Check if a draft already exists for this entity
      const draftsTarget = target.drafts
      if (!draftsTarget) return next()

      // Build where clause from request
      const where = req.query?.SELECT?.from?.ref?.[0]?.where ?? req.params?.[0]
      if (!where) return next()

      const draftRow = await cds.run(
        SELECT.one
          .from(draftsTarget)
          .columns(['DraftAdministrativeData_DraftUUID', 'IsActiveEntity'])
          .where(Array.isArray(where) ? where : [where])
      )

      if (!draftRow) {
        // No draft exists — let standard handler create it
        // After creation, we'll add the user as originator via after hook
        LOG.debug(`[collab-draft] No existing draft found — creating new draft for ${req.user.id}`)
        return next()
      }

      const draftUUID = draftRow.DraftAdministrativeData_DraftUUID
      LOG.info(`[collab-draft] User ${req.user.id} joining existing draft ${draftUUID}`)

      // Check if this user is the draft creator (originator) from DB
      let isOriginator = false
      try {
        const adminRows = await cds.db.run(
          `SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
          [draftUUID]
        )
        const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser
        isOriginator = createdBy === req.user.id
      } catch {}

      await presence.join(draftUUID, req.user.id, {
        displayName: getUserDisplayName(req),
        isOriginator
      })

      // Update InProcessByUser so CAP's lock check doesn't block the user
      // on subsequent PATCH operations — we'll handle this differently
      // We need to return the existing draft data as if this user created it
      const draftData = await cds.run(
        SELECT.one.from(draftsTarget).where(Array.isArray(where) ? where : [where])
      )

      if (!draftData) return next()

      // Update DraftAdministrativeData to show this user is now in process
      // For collaborative draft, we use empty InProcessByUser (shared ownership)
      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: '' }) // empty = shared collaborative draft
          .where({ DraftUUID: draftUUID })
      )

      // Return the draft data with IsActiveEntity: false to signal we're now in draft mode
      draftData.IsActiveEntity = false
      draftData.HasActiveEntity = true

      if (req.res) {
        req.res.status(200)
      }

      return draftData
    } catch (err) {
      LOG.error('[collab-draft] Error in EDIT handler:', err.message)
      return next()
    }
  })

  //
  // ── after EDIT hook — register originator ─────────────────────────────────────
  //
  srv.after('EDIT', '*', async function afterCollaborativeEdit(result, req) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return
    if (!result) return

    // In lean_draft mode the draftEdit result is the entity itself (not draft admin data),
    // so DraftAdministrativeData_DraftUUID is often absent. Look it up from the drafts table.
    let draftUUID = result?.DraftAdministrativeData_DraftUUID

    if (!draftUUID && result?.ID) {
      // Query the draft entity using the entity's primary key
      const target = req.target?.actives?.drafts ?? req.target?.drafts
      if (target) {
        try {
          const row = await cds.run(
            SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: result.ID })
          )
          draftUUID = row?.DraftAdministrativeData_DraftUUID
        } catch (err) {
          LOG.debug('[collab-draft] Could not look up DraftUUID after EDIT:', err.message)
        }
      }
    }

    if (!draftUUID) return

    // Register as originator if not already a participant (i.e. this user created the draft via next())
    if (!presence.isParticipant(draftUUID, req.user.id)) {
      LOG.debug(`[collab-draft] Registering ${req.user.id} as originator of draft ${draftUUID}`)
      await presence.join(draftUUID, req.user.id, {
        displayName: getUserDisplayName(req),
        isOriginator: true
      })
    }

    // Mark this as a shared (collaborative) draft in DraftAdministrativeData.
    // DraftAccessType and CollaborativeDraftEnabled are added via DDL migration → raw SQL.
    // Note: We do NOT clear InProcessByUser here. lean_draft sets it to the originator, and
    // our srv.handle wrapper pre-sets it to the current user before every lean_draft check,
    // so each user can read/patch/call actions on the draft regardless of what InProcessByUser holds.
    try {
      await cds.db.run(
        'UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?',
        ['S', draftUUID]
      )
    } catch (err) {
      LOG.debug('[collab-draft] Could not set DraftAccessType:', err.message)
    }
  })

  //
  // ── before UPDATE (PATCH) — field-level locking ───────────────────────────────────────
  //
  srv.before('UPDATE', '*', async function onCollaborativePatch(req, next) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    // In lean_draft mode isDraft/drafts are undefined — check the entity key instead.
    // Only act on draft entities (IsActiveEntity = false).
    const keyObj = req.params?.[0]
    if (!keyObj || typeof keyObj !== 'object') return
    if (keyObj.IsActiveEntity !== false) return

    const target = req.target

    try {
      // Extract which fields are being patched
      const patchedFields = fieldLocks.extractPatchedFields(req.data)
      if (patchedFields.length === 0) return

      // Look up DraftUUID from the entity table (lean_draft: same table, IsActiveEntity=0)
      // We query using the entity's primary key (ID field), skipping IsActiveEntity.
      const entityID = keyObj.ID
      if (!entityID) return

      // Use the shared helper that knows about lean_draft's .drafts entity
      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      const entityName = target.name
      const entityKey = fieldLocks.serializeEntityKey(req)

      // Check this is actually a collaborative draft (DraftAccessType = 'S')
      const isCollab = await _isDraftCollaborative(draftUUID)
      if (!isCollab) return

      // Heartbeat — update participant's lastSeen
      await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req))

      // Attempt to acquire field-level locks for all patched fields
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
    } catch (err) {
      LOG.error('[collab-draft] Error in PATCH handler:', err.message)
      // Don't block the PATCH on error
    }
  })

  //
  // ── after UPDATE (PATCH) — emit CollaborativeDraftChanged ──────────────────────
  //
  srv.after('UPDATE', '*', async function afterCollaborativePatch(result, req) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return
    const keyObj = req.params?.[0]
    if (!keyObj || typeof keyObj !== 'object') return
    if (keyObj.IsActiveEntity !== false || !keyObj.ID) return
    emitCollabEvent('CollaborativeDraftChanged', _entitySetName(req), keyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
  })

  //
  // ── before draftPrepare — cross-participant validation ────────────────────────
  //
  srv.before('draftPrepare', '*', async function onCollaborativePrepare(req) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    try {
      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      // Validate consistency
      const { valid, issues } = await merge.validateBeforeActivation(draftUUID)
      if (!valid) {
        LOG.warn(`[collab-draft] Draft ${draftUUID} has consistency issues:`, issues)
        // Don't block — just log. Activate will proceed with last-write-wins.
      }

      // Allow any participant to prepare (not just InProcessByUser)
      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: req.user.id })
          .where({ DraftUUID: draftUUID })
      )
    } catch (err) {
      LOG.error('[collab-draft] Error in draftPrepare handler:', err.message)
    }
  })

  //
  // ── before draftActivate ──────────────────────────────────────────────────────
  //
  srv.before('draftActivate', '*', async function onCollaborativeActivate(req) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    try {
      const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities)
      if (!draftUUID) return

      LOG.info(`[collab-draft] User ${req.user.id} activating collaborative draft ${draftUUID}`)

      // Allow any participant to activate — set InProcessByUser to current user
      await cds.run(
        UPDATE('DRAFT.DraftAdministrativeData')
          .data({ InProcessByUser: req.user.id })
          .where({ DraftUUID: draftUUID })
      )
    } catch (err) {
      LOG.error('[collab-draft] Error in draftActivate before handler:', err.message)
    }
  })

  //
  // ── after draftActivate — cleanup ────────────────────────────────────────────
  //
  srv.after('draftActivate', '*', async function afterCollaborativeActivate(result, req) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return

    // The draft UUID was in the request before deletion — we need to get it from result or req
    // At this point the draft is deleted, but we stored participants by draftUUID
    // We need to clean up by matching participant entries
    // The result contains the activated entity — find its draftUUID from participants store
    // For cleanup, we iterate the presence store to find stale entries
    LOG.debug('[collab-draft] Draft activated — cleaning up collaborative artifacts')

    // Try to get the draft UUID from the result (may have been on req.data before activation)
    const draftUUID = req._collabDraftUUID
    if (draftUUID) {
      await merge.cleanup(draftUUID)
    }

    // Notify participants that the draft is gone (presence changed)
    const entityID = req._collabEntityID ?? req.params?.[0]?.ID ?? result?.ID
    if (entityID) {
      emitCollabEvent('CollaborativePresenceChanged', _entitySetName(req), entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
    }
  })

  //
  // ── on CANCEL / DELETE ────────────────────────────────────────────────────────
  // Registered via srv.on so we can intercept BEFORE lean_draft's on('CANCEL') handler.
  // For collaborators: remove from presence, release locks, return null (→ 204, draft survives).
  // For originators: cleanup all state, then call next() so lean_draft deletes the draft.
  //
  srv.on('CANCEL', '*', async function onCollaborativeCancel(req, next) {
    if (!isCollaborativeTarget(req, collaborativeEntities)) return next()

    try {
      const target = req.target?.isDraft ? req.target : req.target?.drafts
      if (!target) return next()

      const where = req.query?.DELETE?.from?.ref?.[0]?.where ?? req.params?.[0]
      if (!where) return next()

      const row = await cds.run(
        SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where(
          Array.isArray(where) ? where : [where]
        )
      )

      if (!row?.DraftAdministrativeData_DraftUUID) return next()

      const draftUUID = row.DraftAdministrativeData_DraftUUID

      // Determine if user is originator. The DB's CreatedByUser is the source of truth —
      // the in-memory presence store may have stale originator flags (e.g. after re-joining
      // via ColDraftShare which always sets originator=false).
      let isOrig = false
      try {
        const adminRows = await cds.db.run(
          `SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
          [draftUUID]
        )
        const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser
        isOrig = createdBy === req.user.id
      } catch (err) {
        LOG.debug('[collab-draft] Could not look up CreatedByUser for CANCEL:', err.message)
        isOrig = presence.isOriginator(draftUUID, req.user.id)
      }

      if (isOrig) {
        // Originator cancels → cleanup collaborative state, then let lean_draft delete the draft
        LOG.info(`[collab-draft] Originator ${req.user.id} cancelling draft ${draftUUID} — removing all participants`)
        await merge.cleanup(draftUUID)
        return next()
      } else {
        // Non-originator leaves — remove only this participant; draft survives
        LOG.info(`[collab-draft] Participant ${req.user.id} leaving draft ${draftUUID}`)
        await presence.leave(draftUUID, req.user.id)
        await fieldLocks.releaseLocks(draftUUID, req.user.id)

        // Notify remaining participants (fire-and-forget)
        const entityID = (Array.isArray(req.params?.[0]) ? null : req.params?.[0]?.ID) ??
          req.query?.DELETE?.from?.ref?.[0]?.where?.find?.(w => w?.ref?.[0] === 'ID' && w?.val)?.val
        const entitySetName = _entitySetName(req)
        if (entityID) {
          emitCollabEvent('CollaborativePresenceChanged', entitySetName, entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})
        }

        // Returning null from a CAP on-handler for a DELETE-type event results in HTTP 204
        // without deleting the draft (we short-circuit the handler chain).
        return null
      }
    } catch (err) {
      LOG.error('[collab-draft] Error in CANCEL handler:', err.message)
      return next()
    }
  })

  //
  // ── after READ on DraftAdministrativeData — inject collaborative draft fields ──
  //
  srv.after('READ', 'DraftAdministrativeData', async function afterReadDraftAdmin(result, req) {
    if (!result) return

    const results = Array.isArray(result) ? result : [result]
    for (const row of results) {
      if (!row?.DraftUUID) continue

      const draftUUID = row.DraftUUID

      // CollaborativeDraftEnabled: prefer the value already in the row (set from DB view),
      // falling back to DraftAccessType check or presence store.
      // The DB column is set to 1 when the draft becomes collaborative (in EDIT / ColDraftShare handlers).
      if (!row.CollaborativeDraftEnabled) {
        const isCollab = row.DraftAccessType === 'S' || presence.getParticipants(draftUUID).length > 0
        row.CollaborativeDraftEnabled = isCollab
      }

      // FE's CollaborationCommon calls .replace() on string fields — ensure never null
      if (row.InProcessByUser === null || row.InProcessByUser === undefined) row.InProcessByUser = ''
      if (row.CreatedByUser === null || row.CreatedByUser === undefined) row.CreatedByUser = ''
      if (row.LastChangedByUser === null || row.LastChangedByUser === undefined) row.LastChangedByUser = ''
    }
  })

  //
  // ── READ on DraftAdministrativeUser — serve participants ─────────────────────
  // Fiori Elements navigates to DraftAdministrativeData/DraftAdministrativeUser to
  // display participant avatars. We serve it from the presence store + DB.
  //
  srv.on('READ', 'DraftAdministrativeUser', async function onReadDraftAdminUser(req) {
    // Resolve DraftUUID from multiple possible sources:
    // 1. req.params contains keys from ancestor navigation segments.
    //    For /Orders(ID=x,IsActiveEntity=false)/DraftAdministrativeData/DraftAdministrativeUser
    //    params is [{ID:'x', IsActiveEntity:false}, {DraftUUID:'...'}]
    // 2. OData $filter ?$filter=DraftUUID eq 'xxx'
    // 3. Direct entity key access

    let draftUUID = null

    // Check all params for a DraftUUID value
    if (req.params?.length) {
      for (const p of req.params) {
        if (p?.DraftUUID) { draftUUID = p.DraftUUID; break }
      }
    }

    // Check OData $filter clause: [{ref:['DraftUUID']}, '=', {val:'...'}]
    if (!draftUUID) {
      const where = req.query?.SELECT?.where
      if (Array.isArray(where)) {
        for (let i = 0; i < where.length - 2; i++) {
          if (where[i]?.ref?.[0] === 'DraftUUID' && where[i + 2]?.val) {
            draftUUID = where[i + 2].val
            break
          }
        }
      }
    }

    // If we have an entity ID from a parent Order, look up its DraftUUID
    if (!draftUUID) {
      const entityID = req.params?.find(p => p?.ID)?.ID
      if (entityID) {
        for (const entityName of collaborativeEntities) {
          const entity = srv.entities[entityName]
          if (!entity?.drafts) continue
          try {
            const row = await cds.run(
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
      LOG.debug('[collab-draft] DraftAdministrativeUser READ: could not resolve DraftUUID from request')
      return []
    }

    const inMemory = presence.getParticipants(draftUUID)
    if (inMemory.length > 0) {
      return inMemory.map(p => ({
        DraftUUID: draftUUID,
        UserID: p.userID || 'unknown',
        UserDescription: p.displayName || p.userID || 'Unknown User',
        UserEditingState: p.isOriginator ? 'Originator' : 'Collaborator'
      }))
    }

    // Fallback: load from DB (survives server restarts)
    try {
      const rows = await cds.run(
        SELECT.from('DRAFT.DraftParticipants')
          .columns(['UserID', 'UserDescription', 'IsOriginator'])
          .where({ DraftUUID: draftUUID })
      )
      if (rows.length > 0) {
        // Repopulate in-memory store from DB
        for (const r of rows) {
          presence.join(draftUUID, r.UserID, {
            displayName: r.UserDescription || r.UserID,
            isOriginator: r.IsOriginator === true || r.IsOriginator === 1
          }).catch(() => {})
        }
        return rows.map(r => ({
          DraftUUID: draftUUID,
          UserID: r.UserID || 'unknown',
          UserDescription: r.UserDescription || r.UserID || 'Unknown User',
          UserEditingState: (r.IsOriginator === true || r.IsOriginator === 1) ? 'Originator' : 'Collaborator'
        }))
      }
    } catch (err) {
      LOG.debug('[collab-draft] Could not load DraftAdministrativeUser from DB:', err.message)
    }

    return []
  })

  //
  // ── ColDraftShare bound actions — participant self-registration ───────────────
  // Fiori Elements automatically calls <Entity>_ColDraftShare when the user opens
  // a collaborative draft. This registers them as a participant (non-originator).
  //
  for (const entityName of collaborativeEntities) {
    const shortName = entityName.split('.').pop()
    const actionName = `${shortName}_ColDraftShare`

    srv.on(actionName, async function onColDraftShare(req) {
      // DraftUUID can come from req.data (when called directly) or from the bound entity key.
      // When FE calls this as a bound action on Orders(ID=...,IsActiveEntity=false),
      // we look up the DraftUUID from the draft entity.
      let draftUUID = req.data?.DraftUUID

      if (!draftUUID) {
        // Look up from the entity key in req.params
        // req.params[0] is a plain object like { ID: 'uuid', IsActiveEntity: false }
        // We use it to query the drafts table for DraftAdministrativeData_DraftUUID.
        // Use req.target.drafts to get the draft entity definition (correct service-qualified name).
        const keyObj = req.params?.[0]
        if (keyObj && typeof keyObj === 'object') {
          const draftsTarget = req.target?.drafts ?? req.target?.actives?.drafts
          if (draftsTarget) {
            try {
              // Filter out virtual keys (IsActiveEntity is computed, not a real DB key)
              const whereObj = Object.fromEntries(
                Object.entries(keyObj).filter(([k]) => k !== 'IsActiveEntity')
              )
              const draftRow = await cds.run(
                SELECT.one
                  .from(draftsTarget)
                  .columns(['DraftAdministrativeData_DraftUUID'])
                  .where(whereObj)
              )
              draftUUID = draftRow?.DraftAdministrativeData_DraftUUID
            } catch (err) {
              LOG.debug(`[collab-draft] ${actionName}: could not look up DraftUUID:`, err.message)
            }
          }
        }
      }

      if (!draftUUID) {
        LOG.debug(`[collab-draft] ${actionName} called without DraftUUID — ignoring`)
        return
      }

      LOG.info(`[collab-draft] ${actionName}: user ${req.user.id} joining draft ${draftUUID}`)

      try {
        // Add the user as a participant (non-originator if not already present)
        if (!presence.isParticipant(draftUUID, req.user.id)) {
          await presence.join(draftUUID, req.user.id, {
            displayName: getUserDisplayName(req),
            isOriginator: false
          })
        } else {
          // Already a participant — refresh heartbeat
          await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req))
        }

        // Set InProcessByUser to '' (shared) and DraftAccessType = 'S' (collaborative)
        // Note: DraftAccessType is added via DDL migration, not in compiled model → raw SQL
        await cds.run(
          UPDATE('DRAFT.DraftAdministrativeData')
            .data({ InProcessByUser: '' })
            .where({ DraftUUID: draftUUID })
        )
        try {
          await cds.db.run(
            'UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?',
            ['S', draftUUID]
          )
        } catch (err) {
          LOG.debug('[collab-draft] Could not set DraftAccessType in ColDraftShare:', err.message)
        }

        // Notify via WS: emit JOIN message so other clients add this user to activeUsers,
        // and emit JOINECHOs with existing participants so this user adds them.
        const entityKeyObj = req.params?.[0]
        if (entityKeyObj?.ID) {
          emitCollabEvent('CollaborativePresenceChanged', shortName, entityKeyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => {})

          // Emit JOIN via WS collaboration protocol (PCP MESSAGE)
          try {
            const wsService = await cds.connect.to('CollabDraftWebSocketService').catch(() => null)
            if (wsService) {
              const userName = getUserDisplayName(req)
              const displayName = userName.charAt(0).toUpperCase() + userName.slice(1) + ' User'
              const clientContent = `/${shortName}(ID=${entityKeyObj.ID},IsActiveEntity=false)`

              // JOIN: broadcast to all (each client adds this user to their activeUsers)
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

              // JOINECHO: send info about each EXISTING participant so the new user adds them
              const participants = presence.getParticipants(draftUUID)
              for (const p of participants) {
                if (p.userID === req.user.id) continue
                const pBase = (p.displayName || p.userID)
                const pName = pBase.charAt(0).toUpperCase() + pBase.slice(1) + ' User'
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
          } catch (err) {
            LOG.debug('[collab-draft] WS JOIN emit failed:', err.message)
          }
        }
      } catch (err) {
        LOG.error(`[collab-draft] Error in ${actionName}:`, err.message)
      }
    })

    LOG.debug(`[collab-draft] Registered ${actionName} handler for ${entityName}`)
  }

  LOG.info(`[collab-draft] Collaborative draft handlers registered for service ${srv.name}`)
}

/**
 * Checks if a draft UUID has collaborative draft enabled (has participants in store).
 * @param {string} draftUUID
 * @returns {Promise<boolean>}
 */
async function _isDraftCollaborative(draftUUID) {
  // Check DraftAccessType = 'S' in DB (most reliable — set in after EDIT)
  try {
    const rows = await cds.db.run(
      `SELECT DraftAccessType FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`,
      [draftUUID]
    )
    const accessType = Array.isArray(rows) ? rows[0]?.DraftAccessType : rows?.DraftAccessType
    if (accessType === 'S') return true
  } catch (_err) { /* fall through */ }

  // Fallback: presence store or DB participants
  if (presence.getParticipants(draftUUID).length > 0) return true
  try {
    const row = await cds.run(SELECT.one.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID }))
    return !!row
  } catch (_err) {
    return false
  }
}

/**
 * Looks up DraftUUID for the entity referenced in a request.
 * Works in both standard and lean_draft modes.
 * @param {object} req
 * @param {object} srv
 * @param {Set<string>} collaborativeEntities
 * @returns {Promise<string|null>}
 */
async function _lookupDraftUUID(req, srv, collaborativeEntities) {
  const keyObj = req.params?.[0]
  if (!keyObj || typeof keyObj !== 'object') return null

  const entityID = keyObj.ID
  if (!entityID) return null

  // In lean_draft mode, req.target is the combined entity (e.g. OrderService.Orders),
  // but req.target.drafts is the drafts-only entity (OrderService.Orders.drafts) which
  // has the DraftAdministrativeData_DraftUUID column. Try drafts entity first.
  const candidates = [
    req.target?.drafts,
    req.target?.actives?.drafts,
    req.target
  ]

  for (const target of candidates) {
    if (!target) continue
    try {
      // For draft entities (lean_draft), query by ID only (no IsActiveEntity filter needed)
      const row = await cds.run(
        SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID })
      )
      if (row?.DraftAdministrativeData_DraftUUID) return row.DraftAdministrativeData_DraftUUID
    } catch (_err) { /* try next candidate */ }
  }

  // Try each collaborative entity definition's drafts
  for (const entityName of collaborativeEntities) {
    const entity = srv.entities?.[entityName]
    if (!entity) continue
    for (const target of [entity.drafts, entity]) {
      if (!target) continue
      try {
        const row = await cds.run(
          SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID })
        )
        if (row?.DraftAdministrativeData_DraftUUID) return row.DraftAdministrativeData_DraftUUID
      } catch (_err) { /* try next */ }
    }
  }

  return null
}

module.exports = { registerHandlers, getCollaborativeEntities }
