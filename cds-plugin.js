'use strict'

const cds = require('@sap/cds')
const LOG = cds.log('collab-draft')
const { augmentModel, augmentCompiledModel } = require('./lib/model-augmenter')
const { registerHandlers, getCollaborativeEntities } = require('./lib/draft-handlers')
const presence = require('./lib/presence')

// Auto-register the WebSocket service if @cap-js-community/websocket is installed.
// Resolution starts from process.cwd() (the consumer app) so that packages installed
// in the consumer's node_modules are found, not just the plugin's own node_modules.
const _wsAvailable = (() => {
  try {
    require.resolve('@cap-js-community/websocket', { paths: [process.cwd(), __dirname] })
    return true
  } catch { return false }
})()

/**
 * Injects the CollabDraftWebSocketService definition directly into a compiled CSN.
 * Called from cds.on('loaded') when @cap-js-community/websocket is installed.
 * @param {object} csn
 */
function _injectWsServiceIntoCSN(csn) {
  if (!csn.definitions) csn.definitions = {}
  csn.definitions['CollabDraftWebSocketService'] = {
    kind: 'service',
    '@protocol': 'ws',
    '@path': '/ws/collab-draft',
    '@ws.format': 'pcp'
  }
  const _eventElements = {
    ID: { kind: 'element', type: 'cds.UUID' },
    IsActiveEntity: { kind: 'element', type: 'cds.Boolean' },
    serverAction: { kind: 'element', type: 'cds.String' },
    sideEffectSource: { kind: 'element', type: 'cds.String' },
    sideEffectEventName: { kind: 'element', type: 'cds.String' },
    userID: { kind: 'element', type: 'cds.String' },
    userDescription: { kind: 'element', type: 'cds.String' }
  }
  csn.definitions['CollabDraftWebSocketService.CollaborativePresenceChanged'] = {
    kind: 'event',
    '@ws.pcp.action': 'CollaborativePresenceChanged',
    elements: { ..._eventElements }
  }
  csn.definitions['CollabDraftWebSocketService.CollaborativeDraftChanged'] = {
    kind: 'event',
    '@ws.pcp.action': 'CollaborativeDraftChanged',
    elements: { ..._eventElements }
  }
  // MESSAGE: FE sends collaboration protocol (JOIN, LOCK, CHANGE, LEAVE) as PCP
  // frames with pcp-action:MESSAGE. The payload is in PCP HEADER fields, not the body.
  // We define both action (client→server) and event (server→client broadcast) with
  // matching fields so the PCP parser can capture and relay all header values.
  const _msgFields = {
    userAction: { type: 'cds.String' },
    clientAction: { type: 'cds.String' },
    clientContent: { type: 'cds.String' },
    clientTriggeredActionName: { type: 'cds.String' },
    clientRefreshListBinding: { type: 'cds.String' },
    clientRequestedProperties: { type: 'cds.String' },
    userID: { type: 'cds.String' },
    userDescription: { type: 'cds.String' }
  }
  csn.definitions['CollabDraftWebSocketService.MESSAGE'] = {
    kind: 'action',
    '@ws.pcp.action': 'MESSAGE',
    params: { ..._msgFields }
  }
  csn.definitions['CollabDraftWebSocketService.message'] = {
    kind: 'event',
    '@ws.pcp.action': 'MESSAGE',
    elements: Object.fromEntries(
      Object.entries(_msgFields).map(([k, v]) => [k, { ...v, kind: 'element' }])
    )
  }
  LOG.debug('[collab-draft] Auto-registered CollabDraftWebSocketService in CSN')
}

LOG.info('cap-collaborative-draft plugin loaded')

//
// ── $metadata middleware
// Patches the $metadata XML response to add:
//   1. CollaborativeDraftEnabled and DraftAccessType properties to DraftAdministrativeData EntityType
//   2. DraftAdministrativeUser EntityType (virtual, for FE participant avatars)
//   3. DraftAdministrativeUser EntitySet (if using model-provider path)
//   4. NavigationProperty DraftAdministrativeUser on DraftAdministrativeData EntityType
//   5. NavigationPropertyBinding Path="DraftAdministrativeData/DraftAdministrativeUser" on draft EntitySets
//
// These cannot be added via the CDS compiler because:
//   - augmentCompiledModel() runs after EDMX lazy-compilation caches, so model mutations don't appear
//   - Pre-defining DRAFT.DraftAdministrativeData in raw CSN causes compilation errors
//     (minifier strips _DraftMessage type, SQL translator recompile fails)
//
cds.on('bootstrap', app => {
  // Expose /user-api/currentUser so the FLP sandbox can resolve the Shell user
  // from the HTTP-authenticated identity. In production this is served by the approuter.
  // Responds with 401 + WWW-Authenticate if no credentials → triggers browser login dialog.
  app.get('/user-api/currentUser', (req, res) => {
    let id = 'anonymous'
    const authHeader = req.headers?.authorization
    if (authHeader?.startsWith('Basic ')) {
      try { id = Buffer.from(authHeader.slice(6), 'base64').toString().split(':')[0] || id } catch {}
    }
    if (id === 'anonymous') {
      res.set('WWW-Authenticate', 'Basic realm="CAP"')
      return res.status(401).json({ error: 'Unauthorized' })
    }
    const displayName = id.charAt(0).toUpperCase() + id.slice(1)
    res.json({
      name: id,
      displayName,
      firstName: displayName,
      lastName: '',
      email: `${id}@example.com`,
      isAuthenticated: true
    })
  })

  app.use((req, res, next) => {
    if (!req.path?.endsWith('/$metadata')) return next()

    // Intercept the response
    const originalSend = res.send.bind(res)
    res.send = function(body) {
      if (typeof body !== 'string' || !body.includes('<EntityContainer')) return originalSend(body)

      let changed = false

      // Extract the schema namespace (e.g. "OrderService") from <Schema Namespace="...">
      const nsMatch = body.match(/<Schema Namespace="([^"]+)"/)
      const ns = nsMatch ? nsMatch[1] : 'self'

      // ── 1. Inject CollaborativeDraftEnabled and DraftAccessType into DraftAdministrativeData EntityType ──
      // These are standard OData Properties needed by FE to detect collaborative draft state.
      if (!body.includes('Name="CollaborativeDraftEnabled"')) {
        body = body.replace(
          /(<EntityType Name="DraftAdministrativeData">[\s\S]*?)(\s*<\/EntityType>)/,
          (match, open, close) => {
            const newProps = [
              '\n        <Property Name="CollaborativeDraftEnabled" Type="Edm.Boolean"/>',
              '\n        <Property Name="DraftAccessType" Type="Edm.String" MaxLength="1"/>'
            ].join('')
            return open + newProps + close
          }
        )
        changed = true
        LOG.debug('[collab-draft] Injected CollaborativeDraftEnabled/DraftAccessType into $metadata DraftAdministrativeData EntityType')
      }

      // ── 2. Inject DraftAdministrativeUser NavigationProperty into DraftAdministrativeData EntityType ──
      // Required for UI5 OData v4 metamodel to resolve DraftAdministrativeData/DraftAdministrativeUser
      // in $select paths (used by FE collaborative draft participant avatar feature).
      // Check specifically inside DraftAdministrativeData EntityType for the nav prop.
      {
        const hasNavPropInDAD = /<EntityType Name="DraftAdministrativeData">[\s\S]*?NavigationProperty[^>]*Name="DraftAdministrativeUser"/.test(body)
        if (!hasNavPropInDAD && body.includes('EntityType Name="DraftAdministrativeData"')) {
          body = body.replace(
            /(<EntityType Name="DraftAdministrativeData">[\s\S]*?)(\s*<\/EntityType>)/,
            (match, open, close) => {
              const navProp = `\n        <NavigationProperty Name="DraftAdministrativeUser" Type="Collection(${ns}.DraftAdministrativeUser)" ContainsTarget="true"/>`
              return open + navProp + close
            }
          )
          changed = true
          LOG.debug('[collab-draft] Injected DraftAdministrativeUser NavigationProperty into $metadata')
        }
      }

      // ── 3. Inject DraftAdministrativeUser EntityType (if not present) ──
      // FE reads UserID, UserDescription, UserEditingState from this type.
      // Note: augmentCompiledModel() adds this entity to the compiled model, so it usually
      // appears in EDMX automatically. This block is a fallback for edge cases.
      if (!body.includes('EntityType Name="DraftAdministrativeUser"')) {
        const entityType = [
          `\n    <EntityType Name="DraftAdministrativeUser">`,
          `\n        <Key><PropertyRef Name="DraftUUID"/><PropertyRef Name="UserID"/></Key>`,
          `\n        <Property Name="DraftUUID" Type="Edm.Guid" Nullable="false"/>`,
          `\n        <Property Name="UserID" Type="Edm.String" Nullable="false" MaxLength="256"/>`,
          `\n        <Property Name="UserDescription" Type="Edm.String" MaxLength="256"/>`,
          `\n        <Property Name="UserEditingState" Type="Edm.String" MaxLength="32"/>`,
          `\n    </EntityType>`
        ].join('')
        // Inject before closing Schema tag
        body = body.replace('</Schema>', entityType + '\n</Schema>')
        changed = true
        LOG.debug('[collab-draft] Injected DraftAdministrativeUser EntityType into $metadata (fallback)')
      }

      // ── 4. Inject NavigationPropertyBinding for DraftAdministrativeData/DraftAdministrativeUser ──
      // Required for UI5 OData v4 metamodel NavigationPropertyBinding resolution on draft EntitySets.
      // We identify draft EntitySets by the presence of SiblingEntity binding.
      if (!body.includes('Path="DraftAdministrativeData/DraftAdministrativeUser"')) {
        body = body.replace(
          /(<EntitySet Name="(?!DraftAdministrativeUser)[^"]*"[^>]*>)([\s\S]*?)(<\/EntitySet>)/g,
          (match, open, inner, close) => {
            if (!inner.includes('Path="SiblingEntity"')) return match
            if (inner.includes('DraftAdministrativeData/DraftAdministrativeUser')) return match
            const binding = '\n          <NavigationPropertyBinding Path="DraftAdministrativeData/DraftAdministrativeUser" Target="DraftAdministrativeUser"/>'
            return open + inner.trimEnd() + binding + '\n        ' + close
          }
        )
        changed = true
        LOG.debug('[collab-draft] Injected DraftAdministrativeUser NavigationPropertyBinding into $metadata EntitySets')
      }

      // ── 5. Inject ColDraftShareUser ComplexType for the ShareAction Users parameter ──
      // FE's Invite Users dialog builds a value-help from this type's properties.
      if (!body.includes('ComplexType Name="ColDraftShareUser"')) {
        const complexType = [
          `\n    <ComplexType Name="ColDraftShareUser">`,
          `\n        <Property Name="UserID" Type="Edm.String" MaxLength="256"/>`,
          `\n    </ComplexType>`
        ].join('')
        body = body.replace('</Schema>', complexType + '\n</Schema>')

        // Fix the action's Users parameter from Edm.String to Collection(ns.ColDraftShareUser)
        body = body.replace(
          /(<Action Name="\w+_ColDraftShare"[^>]*>[\s\S]*?<Parameter Name="Users") Type="Edm\.String"(\/?>)/g,
          `$1 Type="Collection(${ns}.ColDraftShareUser)"$2`
        )
        changed = true
        LOG.debug('[collab-draft] Injected ColDraftShareUser ComplexType + fixed Users param in $metadata')
      }

      // ── 6. Inject WebSocket annotations if @cap-js-community/websocket is installed ──
      // These annotations wire FE's SideEffects mechanism to the WS service.
      // We inject them if not already present (to avoid duplicates if consumer also configures them).
      if (_wsAvailable && !body.includes('Common.WebSocketBaseURL')) {
        body = body.replace(
          /(<Annotations Target="[^"]*EntityContainer"[^>]*>)/,
          (match) => {
            const wsAnnotations = [
              '\n        <Annotation Term="Common.WebSocketBaseURL" String="/ws/collab-draft"/>',
              '\n        <Annotation Term="Common.WebSocketChannel" Qualifier="sideEffects" String="CollaborativePresenceChanged,CollaborativeDraftChanged"/>'
            ].join('')
            return match + wsAnnotations
          }
        )
        // Fallback: if EntityContainer annotations block doesn't exist, create it
        if (!body.includes('Common.WebSocketBaseURL')) {
          const nsMatch2 = body.match(/<Schema Namespace="([^"]+)"/)
          const ns2 = nsMatch2 ? nsMatch2[1] : null
          if (ns2) {
            const wsBlock = [
              `\n    <Annotations Target="${ns2}.EntityContainer">`,
              `\n        <Annotation Term="Common.WebSocketBaseURL" String="/ws/collab-draft"/>`,
              `\n        <Annotation Term="Common.WebSocketChannel" Qualifier="sideEffects" String="CollaborativePresenceChanged,CollaborativeDraftChanged"/>`,
              `\n    </Annotations>`
            ].join('')
            body = body.replace('</Schema>', wsBlock + '\n</Schema>')
          }
        }
        changed = true
        LOG.debug('[collab-draft] Injected WebSocket annotations into $metadata')
      }

      // ── 6. Inject Common.SideEffects for collaborative draft events ──
      // These annotations tell FE to re-read entity data when WS events are received.
      if (_wsAvailable && !body.includes('Common.SideEffects" Qualifier="CollaborativePresenceChanged"')) {
        const sideEffectsXml = [
          '\n        <Annotation Term="Common.SideEffects" Qualifier="CollaborativePresenceChanged">',
          '\n          <Record Type="Common.SideEffectsType">',
          '\n            <PropertyValue Property="SourceEvents"><Collection><String>CollaborativePresenceChanged</String></Collection></PropertyValue>',
          '\n            <PropertyValue Property="TargetProperties"><Collection><String>*</String></Collection></PropertyValue>',
          '\n          </Record>',
          '\n        </Annotation>',
          '\n        <Annotation Term="Common.SideEffects" Qualifier="CollaborativeDraftChanged">',
          '\n          <Record Type="Common.SideEffectsType">',
          '\n            <PropertyValue Property="SourceEvents"><Collection><String>CollaborativeDraftChanged</String></Collection></PropertyValue>',
          '\n            <PropertyValue Property="TargetProperties"><Collection><String>*</String></Collection></PropertyValue>',
          '\n          </Record>',
          '\n        </Annotation>'
        ].join('')

        // Inject into EntityType annotations (NOT EntitySet/EntityContainer).
        // FE resolves SideEffects from the EntityType target (e.g. "OrderService.Orders").
        // We match Annotations blocks whose Target is a 2-segment namespace.entity name
        // (no "/" path separator = EntityType, not EntityContainer/EntitySet).
        // We identify the right entity by presence of UI.HeaderInfo (draft-enabled entities have it).
        body = body.replace(
          /(<Annotations Target="(\w+\.\w+)">)([\s\S]*?)(<\/Annotations>)/g,
          (match, open, target, inner, close) => {
            if (target.includes('/')) return match
            if (!inner.includes('UI.HeaderInfo')) return match
            if (inner.includes('CollaborativePresenceChanged')) return match
            return open + inner.trimEnd() + sideEffectsXml + '\n        ' + close
          }
        )
        changed = true
        LOG.debug('[collab-draft] Injected SideEffects annotations into $metadata')
      }

      if (changed) LOG.debug('[collab-draft] $metadata patched for collaborative draft')
      return originalSend(body)
    }
    next()
  })

  //
  // ── Collaborative PATCH middleware ─────────────────────────────────────────────
  // lean_draft checks InProcessByUser BEFORE running the handler chain.
  // We intercept PATCH requests here (Express layer, runs before CAP's OData handler)
  // and pre-update InProcessByUser so lean_draft's lock check passes for collaborative drafts.
  //
  app.use(async (req, res, next) => {
    if (req.method !== 'PATCH') return next()

    // Match draft entity PATCH: /odata/v4/<svc>/Entity(ID=<uuid>,IsActiveEntity=false)
    const m = req.path.match(/\/odata\/v4\/([^/]+)\/(\w+)\(([^)]+)\)$/)
    if (!m) return next()

    const [, svcPath, entityShortName, keyStr] = m
    if (!keyStr.includes('IsActiveEntity=false')) return next()

    const idMatch = keyStr.match(/ID=([0-9a-f-]{36})/i)
    if (!idMatch) return next()
    const entityID = idMatch[1]

    // Get current user from Basic auth header
    const authHeader = req.headers?.authorization
    let userID = null
    if (authHeader?.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString()
      userID = decoded.split(':')[0]
    }
    if (!userID) return next()

    // Pre-update InProcessByUser before lean_draft's lock check runs
    try {
      const db = cds.db
      if (!db) return next()

      // Find the service by URL path prefix
      let targetSrv = null
      for (const s of Object.values(cds.services || {})) {
        const paths = Array.isArray(s.path) ? s.path : [s.path]
        if (paths.some(p => p?.endsWith('/' + svcPath) || p === '/' + svcPath)) {
          targetSrv = s; break
        }
      }
      if (!targetSrv) return next()

      const entity = targetSrv.entities?.[entityShortName]
      if (!entity) return next()

      // Look up DraftUUID from entity table
      // In lean_draft mode, the draft rows are in a separate _drafts table.
      // Try _drafts table first, then fall back to the main table (standard draft).
      let draftUUID = null
      const baseTable = entity.name.replace(/\./g, '_')
      for (const tbl of [`${baseTable}_drafts`, baseTable]) {
        try {
          const isActiveClause = tbl.endsWith('_drafts') ? '' : ' AND IsActiveEntity = 0'
          const row = await db.run(
            `SELECT DraftAdministrativeData_DraftUUID FROM ${tbl} WHERE ID = ?${isActiveClause}`,
            [entityID]
          )
          const val = Array.isArray(row) ? row[0]?.DraftAdministrativeData_DraftUUID : row?.DraftAdministrativeData_DraftUUID
          if (val) { draftUUID = val; break }
        } catch { /* column may not exist in this table variant, try next */ }
      }
      if (!draftUUID) return next()

      // Only for collaborative drafts (DraftAccessType = 'S')
      const adminRows = await db.run(`SELECT DraftAccessType FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`, [draftUUID])
      const accessType = Array.isArray(adminRows) ? adminRows[0]?.DraftAccessType : adminRows?.DraftAccessType
      if (accessType !== 'S') return next()

      // Set InProcessByUser to current user so lean_draft's lock check passes
      await db.run(`UPDATE DRAFT_DraftAdministrativeData SET InProcessByUser = ? WHERE DraftUUID = ?`, [userID, draftUUID])
      LOG.debug(`[collab-draft] Pre-set InProcessByUser=${userID} for collaborative draft ${draftUUID}`)
    } catch (err) {
      LOG.debug('[collab-draft] Could not pre-set InProcessByUser in middleware:', err.message)
    }

    next()
  })
})

//
// ── Phase 1: Raw CSN Augmentation ────────────────────────────────────────────
// Fires after CSN compilation (cds.load). We add our custom entities
// (DraftParticipants, DraftFieldLocks) to the raw CSN so they get deployed to DB.
//
cds.on('loaded', csn => {
  try {
    augmentModel(csn)
    // Auto-add WS service if @cap-js-community/websocket is installed
    if (_wsAvailable && !csn.definitions?.['CollabDraftWebSocketService']) {
      _injectWsServiceIntoCSN(csn)
    }
  } catch (err) {
    LOG.error('Failed to augment raw CSN:', err.message, err.stack)
  }
})

//
// ── Phase 2: Handler Registration ─────────────────────────────────────────────
// Fires after all services are served. We wrap draft handlers for collaborative entities.
//
cds.on('served', async services => {
  // Augment the compiled model with DraftAdministrativeUser nav prop (for FE participant display)
  // This must happen after compile.for.nodejs, so it goes in the served hook.
  // We use cds.model which is the globally compiled model at this point.
  if (cds.model) {
    augmentCompiledModel(cds.model)
  }

  for (const srv of Object.values(services)) {
    // Only handle ApplicationService instances with draft-enabled entities
    if (!srv.entities?.DraftAdministrativeData) continue

    const collaborativeEntities = getCollaborativeEntities(srv)
    if (collaborativeEntities.size === 0) continue

    LOG.info(
      `[collab-draft] Registering collaborative draft handlers for service ${srv.name} ` +
      `(entities: ${[...collaborativeEntities].join(', ')})`
    )

    // Use prepend to register our handlers BEFORE lean-draft handlers
    // This ensures our EDIT handler gets first crack at draft-join logic
    srv.prepend(() => {
      registerHandlers(srv, collaborativeEntities)
    })
  }

  // Start the presence cleanup timer
  presence.startCleanup()

  // Register MESSAGE relay handler on the CollabDraftWebSocketService.
  // FE's collaboration module sends PCP messages (JOIN, LOCK, CHANGE, LEAVE etc.)
  // with pcp-action:MESSAGE (routed as 'MESSAGE' action by the WS plugin).
  // We broadcast back via the 'message' event so all connected clients see activities.
  if (_wsAvailable) {
    try {
      const wsService = await cds.connect.to('CollabDraftWebSocketService')
      if (wsService) {
        wsService.on('MESSAGE', async (msg) => {
          const d = msg.data || {}
          // Resolve sender identity from the presence store.
          // The WS service is unauthenticated (CAP's auth doesn't work for WS upgrade).
          // We extract the draft UUID from the WS connection URL (?draft=<uuid>) and find
          // the most recently active participant — that's the sender of this message.
          let userId = 'anonymous', displayName = 'Anonymous'
          try {
            // Try WS URL draft param first
            const wsUrl = cds.context?.ws?.socket?.request?.url || ''
            const draftMatch = wsUrl.match(/[?&]draft=([^&]+)/)
            let draftUUID = draftMatch?.[1]

            // Fallback: extract entity ID from clientContent and find the draft
            if (!draftUUID && d.clientContent) {
              const idMatch = d.clientContent.match(/ID=([0-9a-f-]{36})/i)
              if (idMatch) {
                const entityID = idMatch[1]
                // Search all drafts in presence store for one that has this entity
                for (const [uuid, participantMap] of presence._store) {
                  draftUUID = uuid
                  break
                }
                // Better: look up from DB
                try {
                  const rows = await cds.db.run(
                    `SELECT DraftAdministrativeData_DraftUUID FROM OrderService_Orders_drafts WHERE ID = ?`,
                    [entityID]
                  )
                  const val = Array.isArray(rows) ? rows[0]?.DraftAdministrativeData_DraftUUID : rows?.DraftAdministrativeData_DraftUUID
                  if (val) draftUUID = val
                } catch {}
              }
            }

            if (draftUUID) {
              const participants = presence.getParticipants(draftUUID)
              LOG.info(`[collab-draft] MESSAGE resolve: draftUUID=${draftUUID}, ${participants.length} participant(s)`)
              if (participants.length > 0) {
                const sorted = [...participants].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
                userId = sorted[0].userID
                displayName = sorted[0].displayName || userId
              }
            } else {
              LOG.info(`[collab-draft] MESSAGE resolve: no draftUUID found. wsUrl=${wsUrl.substring(0,80)}, clientContent=${d.clientContent}`)
            }
          } catch (e) { LOG.info('[collab-draft] MESSAGE resolve error:', e.message) }
          if (userId !== 'anonymous') {
            displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1) + ' User'
          }
          const relayData = {
            userAction: d.clientAction || '',
            clientAction: d.clientAction || '',
            clientContent: d.clientContent || '',
            clientTriggeredActionName: d.clientTriggeredActionName || '',
            clientRefreshListBinding: d.clientRefreshListBinding || '',
            clientRequestedProperties: d.clientRequestedProperties || '',
            userID: userId,
            userDescription: displayName
          }
          LOG.info(`[collab-draft] Relaying MESSAGE: ${d.clientAction} ${d.clientContent} by ${userId}`)
          try {
            const wsFacade = cds.context?.ws?.service
            if (wsFacade?.broadcast) {
              // broadcast() excludes the sender — others see LOCK/JOIN/CHANGE etc.
              await wsFacade.broadcast('message', relayData)

              // Send JOINECHOs for other participants to the sender.
              // We track which sockets already received echoes to avoid duplicates.
              // Trigger on JOIN, JOINECHO, and the first LOCK (covers all entry paths).
              const wsSocket = cds.context?.ws?.socket
              const needsEcho = wsSocket && !wsSocket._collabJoinEchoed
              if (needsEcho && ['JOIN', 'JOINECHO', 'LOCK'].includes(d.clientAction)) {
                wsSocket._collabJoinEchoed = true
                try {
                  let draftUUID2 = null
                  const wsUrl2 = cds.context?.ws?.socket?.request?.url || ''
                  const dm2 = wsUrl2.match(/[?&]draft=([^&]+)/)
                  draftUUID2 = dm2?.[1]
                  if (!draftUUID2 && d.clientContent) {
                    const idM = d.clientContent.match(/ID=([0-9a-f-]{36})/i)
                    if (idM) {
                      const rows = await cds.db.run(`SELECT DraftAdministrativeData_DraftUUID FROM OrderService_Orders_drafts WHERE ID = ?`, [idM[1]])
                      draftUUID2 = (Array.isArray(rows) ? rows[0] : rows)?.DraftAdministrativeData_DraftUUID
                    }
                  }
                  if (draftUUID2) {
                    const allParticipants = presence.getParticipants(draftUUID2)
                    for (const p of allParticipants) {
                      if (p.userID === userId) continue
                      const pBase = (p.displayName || p.userID)
                      const pName = pBase.charAt(0).toUpperCase() + pBase.slice(1) + ' User'
                      await wsFacade.emit('message', {
                        ...relayData,
                        userAction: 'JOINECHO',
                        clientAction: 'JOINECHO',
                        userID: p.userID,
                        userDescription: pName
                      })
                    }
                  }
                } catch (e) { LOG.debug('[collab-draft] JOINECHO error:', e.message) }
              }
            } else {
              await wsService.emit('message', relayData)
            }
          } catch (err) {
            LOG.debug('[collab-draft] MESSAGE relay failed:', err.message)
          }
        3})
        LOG.info('[collab-draft] Registered MESSAGE relay handler for collaborative draft WS')
      }
    } catch (err) {
      LOG.debug('[collab-draft] Could not register MESSAGE relay:', err.message)
    }
  }

  // Collect service names that have DraftAdministrativeData (done synchronously while services is available).
  // CAP creates a separate DB table per service: <ServiceName>_DraftAdministrativeData
  // These must be migrated in addition to the base DRAFT_DraftAdministrativeData table.
  const draftAdminTables = new Set(['DRAFT_DraftAdministrativeData'])
  for (const srv of Object.values(services)) {
    if (srv.entities?.DraftAdministrativeData) {
      // Table name = service name with dots replaced by underscores + _DraftAdministrativeData
      draftAdminTables.add(`${srv.name.replace(/\./g, '_')}_DraftAdministrativeData`)
    }
  }

  // Add CollaborativeDraftEnabled and DraftAccessType columns to all DraftAdministrativeData tables
  // via DDL migration. These columns are not in the CDS-generated schema because pre-defining
  // DRAFT.DraftAdministrativeData in raw CSN causes CDS compiler errors.
  //
  // For the base table (DRAFT_DraftAdministrativeData): ALTER TABLE ADD COLUMN.
  // For service views (e.g. OrderService_DraftAdministrativeData): the view must be
  // dropped and recreated to include the new columns, since SQLite views use explicit
  // column lists and do not automatically expose new base-table columns.
  setImmediate(async () => {
    try {
      const db = cds.db
      if (!db) return

      // Step 1: Add columns to base table
      for (const sql of [
        `ALTER TABLE DRAFT_DraftAdministrativeData ADD COLUMN CollaborativeDraftEnabled BOOLEAN DEFAULT 0`,
        `ALTER TABLE DRAFT_DraftAdministrativeData ADD COLUMN DraftAccessType NVARCHAR(1) DEFAULT ''`
      ]) {
        try {
          await db.run(sql)
          LOG.debug(`[collab-draft] DDL migration: ${sql}`)
        } catch (err) {
          if (!err.message?.includes('duplicate column') && !err.message?.includes('already exists')) {
            LOG.debug(`[collab-draft] DDL migration skipped (${err.message?.slice(0, 60)})`)
          }
        }
      }

      // Step 2: For each service view, drop and recreate with new columns appended.
      // We read the existing view definition from sqlite_master and add the new columns.
      for (const viewName of draftAdminTables) {
        if (viewName === 'DRAFT_DraftAdministrativeData') continue // that's the base table
        try {
          // Get the current view definition from sqlite_master
          const rows = await db.run(`SELECT sql FROM sqlite_master WHERE type='view' AND name='${viewName}'`)
          const viewSql = Array.isArray(rows) ? rows[0]?.sql : rows?.sql
          if (!viewSql) continue

          // Check if already has our columns
          if (viewSql.includes('CollaborativeDraftEnabled')) continue

          // Inject our columns before the FROM clause
          const updatedViewSql = viewSql.replace(
            /\bFROM\b/i,
            `,\n  DraftAdministrativeData.CollaborativeDraftEnabled,\n  DraftAdministrativeData.DraftAccessType\nFROM`
          )
          await db.run(`DROP VIEW IF EXISTS ${viewName}`)
          await db.run(updatedViewSql)
          LOG.debug(`[collab-draft] Recreated view ${viewName} with CollaborativeDraftEnabled/DraftAccessType`)
        } catch (err) {
          LOG.debug(`[collab-draft] Could not recreate view ${viewName}: ${err.message?.slice(0, 80)}`)
        }
      }
    } catch (err) {
      LOG.warn('[collab-draft] Could not run DDL migration for collaborative draft columns:', err.message)
    }
  })

  // Load persisted participants from DB (after tables are ready)
  // Small delay to ensure DB is initialized
  setImmediate(async () => {
    try {
      await presence.loadFromDB()
    } catch (err) {
      LOG.warn('Could not load participants from DB on startup:', err.message)
    }
  })
})
