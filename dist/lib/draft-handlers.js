'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARE_INVITE_EVENT = void 0;
exports.getCollaborativeEntities = getCollaborativeEntities;
exports.registerHandlers = registerHandlers;
const cds = require("@sap/cds");
const presence = __importStar(require("./presence"));
const fieldLocks = __importStar(require("./field-locks"));
const merge = __importStar(require("./merge"));
const LOG = cds.log('collab-draft');
/**
 * Event name emitted when ColDraftShare is called with Users to invite.
 * App code can listen: cds.on('collab-draft:shareInvite', ({ draftUUID, invitedBy, users }) => { ... })
 * Each entry in `users` has: { UserID: string, UserAccessRole?: string }
 */
exports.SHARE_INVITE_EVENT = 'collab-draft:shareInvite';
// Temporary store for pending invite messages keyed by entityID.
// Consumed once by the DraftMessages READ handler (cleared after first read).
const _pendingInviteMessages = new Map();
/**
 * Emits a WebSocket side-effect event.
 */
async function emitCollabEvent(eventName, entitySetName, entityID, userInfo) {
    try {
        const wsService = await cds.connect.to('CollabDraftWebSocketService').catch(() => null);
        if (!wsService)
            return;
        const sideEffectSource = `/${entitySetName}(ID=${encodeURIComponent(entityID)},IsActiveEntity=false)`;
        await wsService.emit(eventName, {
            ID: entityID,
            IsActiveEntity: false,
            serverAction: 'RaiseSideEffect',
            sideEffectSource,
            sideEffectEventName: eventName,
            userID: userInfo?.id || 'unknown',
            userDescription: userInfo?.name || userInfo?.id || 'Unknown User'
        });
        LOG.debug(`Emitted ${eventName} for ${entitySetName}(${entityID}) by ${userInfo?.id || '?'}`);
    }
    catch (err) {
        LOG.debug(`WS emit skipped: ${err.message}`);
    }
}
/**
 * Derives the OData entity set name (short name) from a target entity name or request.
 */
function _entitySetName(req) {
    const name = req.target?.actives?.name ?? req.target?.name ?? 'Unknown';
    const parts = name.split('.');
    const short = parts[parts.length - 1];
    if (short === 'drafts' && parts.length > 1) {
        return parts[parts.length - 2];
    }
    return short;
}
/**
 * Returns all service entities that have @CollaborativeDraft.enabled
 */
function getCollaborativeEntities(srv) {
    const result = new Set();
    for (const [name, entity] of Object.entries(srv.entities || {})) {
        if (entity?.['@CollaborativeDraft.enabled'] === true && entity?.['@odata.draft.enabled'] === true) {
            result.add(name);
        }
    }
    return result;
}
/**
 * Returns all entities in the composition subtree of collaborative draft entities.
 */
function getCollaborativeSubtree(srv, collaborativeEntities) {
    const subtree = new Set(collaborativeEntities);
    const visited = new Set();
    function walkCompositions(entityDef) {
        if (!entityDef || visited.has(entityDef.name))
            return;
        visited.add(entityDef.name);
        const comps = entityDef.compositions || {};
        for (const comp of Object.values(comps)) {
            const target = comp._target;
            if (!target)
                continue;
            for (const [shortName, e] of Object.entries(srv.entities || {})) {
                if (e.name === target.name) {
                    subtree.add(shortName);
                    break;
                }
            }
            walkCompositions(target);
        }
    }
    for (const entityName of collaborativeEntities) {
        const entity = srv.entities[entityName];
        if (entity)
            walkCompositions(entity);
    }
    return subtree;
}
/**
 * Checks if the request target is a collaborative draft entity
 */
function isCollaborativeTarget(req, collaborativeEntities) {
    const targetName = req.target?.actives?.name ?? req.target?.name;
    for (const name of collaborativeEntities) {
        if (targetName === name || targetName?.endsWith('.' + name.split('.').pop())) {
            return true;
        }
    }
    return false;
}
/**
 * Gets user display name from request context
 */
function getUserDisplayName(req) {
    const id = req.user?.id;
    if (!id)
        return 'Unknown';
    const mockedUsers = cds.env?.requires?.auth?.users ?? {};
    if (mockedUsers[id]?.displayName)
        return mockedUsers[id].displayName;
    return id.charAt(0).toUpperCase() + id.slice(1);
}
/**
 * Registers collaborative draft handlers on a service.
 * Must be called inside srv.prepend() to run before lean-draft handlers.
 */
function registerHandlers(srv, collaborativeEntities) {
    const collaborativeSubtree = getCollaborativeSubtree(srv, collaborativeEntities);
    //
    // ── srv.handle wrapper — pre-update InProcessByUser before lean_draft's lock check ──
    //
    const _origHandle = srv.handle.bind(srv);
    srv.handle = async function collabDraftHandle(req) {
        let _collabDraftUUID = null;
        const keyObj = req.params?.[0];
        const isForDraft = keyObj?.IsActiveEntity === false;
        const entityID = isForDraft ? (keyObj?.ID ?? null) : null;
        if (isForDraft && entityID && isCollaborativeTarget(req, collaborativeSubtree)) {
            try {
                const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities);
                if (draftUUID && await _isDraftCollaborative(draftUUID)) {
                    await cds.db.run('UPDATE DRAFT_DraftAdministrativeData SET InProcessByUser = ? WHERE DraftUUID = ?', [req.user.id, draftUUID]);
                    _collabDraftUUID = draftUUID;
                    LOG.debug(`Pre-set InProcessByUser=${req.user.id} for collab draft ${draftUUID} (event: ${req.event})`);
                }
            }
            catch (err) {
                LOG.debug('Could not pre-set InProcessByUser:', err.message);
            }
        }
        let result;
        try {
            result = await _origHandle(req);
        }
        catch (err) {
            if (err.code === '404' && req.event === 'READ' &&
                isCollaborativeTarget(req, collaborativeSubtree) &&
                req.params?.[0]?.IsActiveEntity === false) {
                LOG.debug(`Suppressed 404 for draft READ after activation: ${req.params?.[0]?.ID}`);
                return null;
            }
            throw err;
        }
        // Emit CollaborativeDraftChanged for child entity mutations in a collaborative draft.
        if (_collabDraftUUID && result != null &&
            !isCollaborativeTarget(req, collaborativeEntities) &&
            req.event !== 'READ') {
            const rootCtx = await _resolveCollabRootContext(_collabDraftUUID, srv, collaborativeEntities).catch(() => null);
            if (rootCtx) {
                emitCollabEvent('CollaborativeDraftChanged', rootCtx.entitySetName, rootCtx.entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => { });
            }
        }
        return result;
    };
    //
    // ── EDIT handler ──────────────────────────────────────────────────────────────
    //
    srv.on('EDIT', '*', async function onCollaborativeEdit(req, next) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return next();
        const target = req.target?.actives ?? req.target;
        if (!target || target.isDraft)
            return next();
        LOG.debug(`EDIT request from ${req.user.id} on ${target.name}`);
        try {
            const draftsTarget = target.drafts;
            if (!draftsTarget)
                return next();
            // Use only the entity ID — never include IsActiveEntity in the draft lookup.
            // req.params[0] carries the ACTIVE entity key ({ID, IsActiveEntity:true}), so passing
            // it directly would contradict the drafts view's implicit IsActiveEntity=false filter
            // and always return no rows.
            const entityID = req.params?.[0]?.ID;
            if (!entityID)
                return next();
            const draftRow = await cds.run(SELECT.one
                .from(draftsTarget)
                .columns(['DraftAdministrativeData_DraftUUID', 'IsActiveEntity'])
                .where({ ID: entityID }));
            if (!draftRow) {
                LOG.debug(`No existing draft found — creating new draft for ${req.user.id}`);
                return next();
            }
            const draftUUID = draftRow.DraftAdministrativeData_DraftUUID;
            LOG.debug(`User ${req.user.id} joining existing draft ${draftUUID}`);
            let isOrig = false;
            try {
                const adminRows = await cds.db.run(`SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`, [draftUUID]);
                const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser;
                isOrig = createdBy === req.user.id;
            }
            catch { }
            await presence.join(draftUUID, req.user.id, {
                displayName: getUserDisplayName(req),
                isOriginator: isOrig
            });
            const draftData = await cds.run(SELECT.one.from(draftsTarget).where({ ID: entityID }));
            if (!draftData)
                return next();
            await cds.run(UPDATE('DRAFT.DraftAdministrativeData')
                .data({ InProcessByUser: '' })
                .where({ DraftUUID: draftUUID }));
            draftData.IsActiveEntity = false;
            draftData.HasActiveEntity = true;
            if (req.res) {
                req.res.status(200);
            }
            return draftData;
        }
        catch (err) {
            LOG.error('Error in EDIT handler:', err.message);
            return next();
        }
    });
    //
    // ── after EDIT hook — register originator ─────────────────────────────────────
    //
    srv.after('EDIT', '*', async function afterCollaborativeEdit(result, req) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return;
        if (!result)
            return;
        let draftUUID = result?.DraftAdministrativeData_DraftUUID;
        if (!draftUUID && result?.ID) {
            const target = req.target?.actives?.drafts ?? req.target?.drafts;
            if (target) {
                try {
                    const row = await cds.run(SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: result.ID }));
                    draftUUID = row?.DraftAdministrativeData_DraftUUID;
                }
                catch (err) {
                    LOG.debug('Could not look up DraftUUID after EDIT:', err.message);
                }
            }
        }
        if (!draftUUID)
            return;
        if (!presence.isParticipant(draftUUID, req.user.id)) {
            LOG.debug(`Registering ${req.user.id} as originator of draft ${draftUUID}`);
            await presence.join(draftUUID, req.user.id, {
                displayName: getUserDisplayName(req),
                isOriginator: true
            });
        }
        try {
            await cds.db.run('UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?', ['S', draftUUID]);
        }
        catch (err) {
            LOG.debug('Could not set DraftAccessType:', err.message);
        }
    });
    //
    // ── before UPDATE (PATCH) — field-level locking ───────────────────────────────────────
    //
    srv.before('UPDATE', '*', async function onCollaborativePatch(req) {
        if (!isCollaborativeTarget(req, collaborativeSubtree))
            return;
        const keyObj = req.params?.[0];
        if (!keyObj || typeof keyObj !== 'object')
            return;
        if (keyObj.IsActiveEntity !== false)
            return;
        const target = req.target;
        try {
            const patchedFields = fieldLocks.extractPatchedFields(req.data);
            if (patchedFields.length === 0)
                return;
            const entityID = keyObj.ID;
            if (!entityID)
                return;
            const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities);
            if (!draftUUID)
                return;
            const entityName = target.name;
            const entityKey = fieldLocks.serializeEntityKey(req);
            const isCollab = await _isDraftCollaborative(draftUUID);
            if (!isCollab)
                return;
            await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req));
            const { acquired, conflicts } = await fieldLocks.acquireLocks({
                draftUUID,
                entityName,
                entityKey,
                fieldNames: patchedFields,
                userID: req.user.id
            });
            if (!acquired && conflicts.length > 0) {
                const conflictMsg = conflicts
                    .map(c => `"${c.fieldName}" (locked by ${c.lockedBy})`)
                    .join(', ');
                req.error(409, `Field lock conflict: ${conflictMsg}. Please try again.`);
                return;
            }
        }
        catch (err) {
            LOG.error('Error in PATCH handler:', err.message);
        }
    });
    //
    // ── after UPDATE (PATCH) — emit CollaborativeDraftChanged ──────────────────────
    //
    srv.after('UPDATE', '*', async function afterCollaborativePatch(_result, req) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return;
        const keyObj = req.params?.[0];
        if (!keyObj || typeof keyObj !== 'object')
            return;
        if (keyObj.IsActiveEntity !== false || !keyObj.ID)
            return;
        emitCollabEvent('CollaborativeDraftChanged', _entitySetName(req), keyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => { });
    });
    //
    // ── before draftPrepare — cross-participant validation ────────────────────────
    //
    srv.before('draftPrepare', '*', async function onCollaborativePrepare(req) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return;
        try {
            const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities);
            if (!draftUUID)
                return;
            const { valid, issues } = await merge.validateBeforeActivation(draftUUID);
            if (!valid) {
                LOG.warn(`Draft ${draftUUID} has consistency issues:`, issues);
            }
            await cds.run(UPDATE('DRAFT.DraftAdministrativeData')
                .data({ InProcessByUser: req.user.id })
                .where({ DraftUUID: draftUUID }));
        }
        catch (err) {
            LOG.error('Error in draftPrepare handler:', err.message);
        }
    });
    //
    // ── before draftActivate ──────────────────────────────────────────────────────
    //
    srv.before('draftActivate', '*', async function onCollaborativeActivate(req) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return;
        try {
            const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities);
            if (!draftUUID)
                return;
            LOG.debug(`User ${req.user.id} activating collaborative draft ${draftUUID}`);
            // Persist on req so the after-handler can clean up without a second DB round-trip
            req._collabDraftUUID = draftUUID;
            req._collabEntityID = req.params?.[0]?.ID ?? null;
            await cds.run(UPDATE('DRAFT.DraftAdministrativeData')
                .data({ InProcessByUser: req.user.id })
                .where({ DraftUUID: draftUUID }));
        }
        catch (err) {
            LOG.error('Error in draftActivate before handler:', err.message);
        }
    });
    //
    // ── after draftActivate — cleanup ────────────────────────────────────────────
    //
    srv.after('draftActivate', '*', async function afterCollaborativeActivate(result, req) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return;
        LOG.debug('Draft activated — cleaning up collaborative artifacts');
        const draftUUID = req._collabDraftUUID;
        if (draftUUID) {
            await merge.cleanup(draftUUID);
        }
        const entityID = req._collabEntityID ?? req.params?.[0]?.ID ?? result?.ID;
        if (entityID) {
            emitCollabEvent('CollaborativePresenceChanged', _entitySetName(req), entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => { });
        }
    });
    //
    // ── on CANCEL / DELETE ────────────────────────────────────────────────────────
    //
    srv.on('CANCEL', '*', async function onCollaborativeCancel(req, next) {
        if (!isCollaborativeTarget(req, collaborativeEntities))
            return next();
        try {
            // Use _lookupDraftUUID for consistent resolution regardless of whether req.target
            // is the root entity or the drafts view (lean_draft sets it to the drafts view for
            // IsActiveEntity=false requests, making req.target?.drafts undefined).
            const draftUUID = await _lookupDraftUUID(req, srv, collaborativeEntities);
            if (!draftUUID)
                return next();
            let isOrig = false;
            try {
                const adminRows = await cds.db.run(`SELECT CreatedByUser FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`, [draftUUID]);
                const createdBy = Array.isArray(adminRows) ? adminRows[0]?.CreatedByUser : adminRows?.CreatedByUser;
                isOrig = createdBy === req.user.id;
            }
            catch (err) {
                LOG.debug('Could not look up CreatedByUser for CANCEL:', err.message);
                isOrig = presence.isOriginator(draftUUID, req.user.id);
            }
            if (isOrig) {
                LOG.debug(`Originator ${req.user.id} cancelling draft ${draftUUID} — removing all participants`);
                await merge.cleanup(draftUUID);
                return next();
            }
            else {
                LOG.debug(`Participant ${req.user.id} leaving draft ${draftUUID}`);
                await presence.leave(draftUUID, req.user.id);
                await fieldLocks.releaseLocks(draftUUID, req.user.id);
                const entityID = (Array.isArray(req.params?.[0]) ? undefined : req.params?.[0]?.ID) ??
                    req.query?.DELETE?.from?.ref?.[0]?.where?.find?.((w) => w?.ref?.[0] === 'ID' && w?.val)?.val;
                const entitySetName = _entitySetName(req);
                if (entityID) {
                    emitCollabEvent('CollaborativePresenceChanged', entitySetName, entityID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => { });
                }
                return null;
            }
        }
        catch (err) {
            LOG.error('Error in CANCEL handler:', err.message);
            return next();
        }
    });
    //
    // ── after READ on DraftAdministrativeData — inject collaborative draft fields ──
    //
    srv.after('READ', 'DraftAdministrativeData', async function afterReadDraftAdmin(result, _req) {
        if (!result)
            return;
        const results = Array.isArray(result) ? result : [result];
        for (const row of results) {
            if (!row?.DraftUUID)
                continue;
            const draftUUID = row.DraftUUID;
            // Always coerce to boolean (SQLite stores booleans as 0/1 integers)
            row.CollaborativeDraftEnabled =
                row.CollaborativeDraftEnabled === true ||
                    row.CollaborativeDraftEnabled === 1 ||
                    row.DraftAccessType === 'S' ||
                    presence.getParticipants(draftUUID).length > 0;
            if (row.InProcessByUser === null || row.InProcessByUser === undefined)
                row.InProcessByUser = '';
            if (row.CreatedByUser === null || row.CreatedByUser === undefined)
                row.CreatedByUser = '';
            if (row.LastChangedByUser === null || row.LastChangedByUser === undefined)
                row.LastChangedByUser = '';
        }
    });
    //
    //
    // ── READ on DraftMessages — required by FE when @Common.DraftRoot.ShareAction is set ──
    // FE navigates to <entity>/DraftMessages to display per-field validation messages from
    // collaborating users. We return an empty collection — CAP's own validation mechanism
    // (@Core.Messages / req.error()) is the authoritative source for errors on PATCH/activate.
    //
    srv.on('READ', 'DraftMessages', async function onReadDraftMessages(req) {
        // Return pending invite feedback messages, then clear them.
        // FE reads DraftMessages after ColDraftShare; returning messages here avoids
        // the "No additional users were invited to ..." toast.
        const entityID = req.params?.[0]?.ID ?? req.params?.[0]?.id;
        if (entityID && _pendingInviteMessages.has(entityID)) {
            const msgs = _pendingInviteMessages.get(entityID);
            _pendingInviteMessages.delete(entityID);
            return msgs;
        }
        return [];
    });
    // ── READ on DraftAdministrativeUser — serve participants ─────────────────────
    //
    srv.on('READ', 'DraftAdministrativeUser', async function onReadDraftAdminUser(req) {
        let draftUUID = null;
        if (req.params?.length) {
            for (const p of req.params) {
                if (p?.DraftUUID) {
                    draftUUID = p.DraftUUID;
                    break;
                }
            }
        }
        if (!draftUUID) {
            const where = req.query?.SELECT?.where;
            if (Array.isArray(where)) {
                for (let i = 0; i < where.length - 2; i++) {
                    if (where[i]?.ref?.[0] === 'DraftUUID' && where[i + 2]?.val) {
                        draftUUID = where[i + 2].val;
                        break;
                    }
                }
            }
        }
        if (!draftUUID) {
            const entityID = req.params?.find((p) => p?.ID)?.ID;
            if (entityID) {
                for (const entityName of collaborativeEntities) {
                    const entity = srv.entities[entityName];
                    if (!entity?.drafts)
                        continue;
                    try {
                        const row = await cds.run(SELECT.one.from(entity.drafts).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID }));
                        if (row?.DraftAdministrativeData_DraftUUID) {
                            draftUUID = row.DraftAdministrativeData_DraftUUID;
                            break;
                        }
                    }
                    catch (_err) { /* try next entity */ }
                }
            }
        }
        if (!draftUUID) {
            LOG.debug('DraftAdministrativeUser READ: could not resolve DraftUUID from request');
            return [];
        }
        const excludeUserIDs = new Set();
        const where = req.query?.SELECT?.where;
        if (Array.isArray(where)) {
            for (let i = 0; i < where.length - 2; i++) {
                if (where[i]?.ref?.[0] === 'UserID' && (where[i + 1] === 'ne' || where[i + 1] === '!=') && where[i + 2]?.val) {
                    excludeUserIDs.add(where[i + 2].val);
                }
            }
        }
        const mockedUsers = cds.env?.requires?.auth?.users ?? {};
        const inMemory = presence.getParticipants(draftUUID);
        if (inMemory.length > 0) {
            return inMemory
                .filter(p => !excludeUserIDs.has(p.userID))
                .map(p => ({
                DraftUUID: draftUUID,
                UserID: p.userID || 'unknown',
                UserDescription: mockedUsers[p.userID]?.displayName || p.displayName || p.userID || 'Unknown User',
                UserEditingState: 'P'
            }));
        }
        try {
            const rows = await cds.run(SELECT.from('DRAFT.DraftParticipants')
                .columns(['UserID', 'UserDescription', 'IsOriginator'])
                .where({ DraftUUID: draftUUID }));
            if (rows.length > 0) {
                for (const r of rows) {
                    presence.join(draftUUID, r.UserID, {
                        displayName: r.UserDescription || r.UserID,
                        isOriginator: r.IsOriginator === true || r.IsOriginator === 1
                    }).catch(() => { });
                }
                return rows
                    .filter(r => !excludeUserIDs.has(r.UserID))
                    .map(r => ({
                    DraftUUID: draftUUID,
                    UserID: r.UserID || 'unknown',
                    UserDescription: r.UserDescription || r.UserID || 'Unknown User',
                    UserEditingState: 'P'
                }));
            }
        }
        catch (err) {
            LOG.debug('Could not load DraftAdministrativeUser from DB:', err.message);
        }
        return [];
    });
    //
    // ── READ on ColDraftUsers — serve available users for invite value help ────────
    //
    srv.on('READ', 'ColDraftUsers', async function onReadColDraftUsers(req) {
        const collabUsersConfig = cds.env.collab?.users;
        // ── Entity-backed mode (enterprise: real DB table / projection) ──────────────
        // Activated when cds.env.collab.users is an object with an `entity` key.
        //
        // Example .cdsrc.json:
        //   "collab": {
        //     "users": {
        //       "entity": "OrderService.Users",
        //       "userIdField": "email",          // optional, default "UserID"
        //       "userDescriptionField": "name"   // optional, default "UserDescription"
        //     }
        //   }
        if (collabUsersConfig?.entity) {
            const entityName = collabUsersConfig.entity;
            const idField = collabUsersConfig.userIdField ?? 'UserID';
            const descField = collabUsersConfig.userDescriptionField ?? 'UserDescription';
            // Extract search term — FE sends either $search or $filter contains(...)
            let searchTerm;
            const search = req.query?.SELECT?.search;
            const where = req.query?.SELECT?.where;
            if (Array.isArray(search)) {
                searchTerm = search.find((s) => s?.val)?.val?.toString();
            }
            else if (Array.isArray(where)) {
                searchTerm = where.find((w) => w?.val)?.val?.toString();
            }
            // Build SELECT with field aliases so result always has UserID / UserDescription
            const q = SELECT.from(entityName).columns(`${idField} as UserID`, `${descField} as UserDescription`);
            // Push search down to DB — much more efficient than in-memory for large directories
            if (searchTerm) {
                q.where(`${idField} like`, `%${searchTerm}%`)
                    .or(`${descField} like`, `%${searchTerm}%`);
            }
            // Pass through $top / $skip for pagination
            const limit = req.query?.SELECT?.limit;
            if (limit) {
                const top = limit.rows?.val ?? limit.rows ?? limit;
                const skip = limit.offset?.val ?? limit.offset;
                if (typeof top === 'number')
                    q.limit(top, typeof skip === 'number' ? skip : undefined);
            }
            LOG.debug(`ColDraftUsers: delegating to entity "${entityName}" (idField: ${idField}, descField: ${descField})`);
            return cds.run(q);
        }
        // ── Static map mode (development / small envs) ────────────────────────────────
        // Source 1: plugin-level static user map (cds.env.collab.users as plain object)
        // Source 2: CAP mock auth users (cds.env.requires.auth.users)
        const authUsers = cds.env.requires?.auth?.users ?? cds.env.requires?.['mock-users']?.users;
        const rawUsers = (typeof collabUsersConfig === 'object' && !collabUsersConfig.entity ? collabUsersConfig : null) ??
            authUsers ??
            {};
        const users = Object.entries(rawUsers).map(([id, info]) => ({
            UserID: id,
            UserDescription: info.displayName ?? info.name ?? info.fullName ?? id
        }));
        // Apply $filter / $search in memory
        const search = req.query?.SELECT?.search;
        const where = req.query?.SELECT?.where;
        let filtered = users;
        if (Array.isArray(where)) {
            const filterVal = where.find((w) => w?.val)?.val?.toString().toLowerCase();
            if (filterVal) {
                filtered = filtered.filter(u => u.UserID.toLowerCase().includes(filterVal) ||
                    u.UserDescription.toLowerCase().includes(filterVal));
            }
        }
        if (Array.isArray(search)) {
            const searchVal = search.find((s) => s?.val)?.val?.toString().toLowerCase();
            if (searchVal) {
                filtered = filtered.filter(u => u.UserID.toLowerCase().includes(searchVal) ||
                    u.UserDescription.toLowerCase().includes(searchVal));
            }
        }
        return filtered;
    });
    //
    // ── ColDraftShare bound actions — participant self-registration ───────────────
    //
    for (const entityName of collaborativeEntities) {
        const shortName = entityName.split('.').pop();
        const actionName = `${shortName}_ColDraftShare`;
        srv.on(actionName, async function onColDraftShare(req) {
            let draftUUID = req.data?.DraftUUID ?? null;
            if (!draftUUID) {
                const keyObj = req.params?.[0];
                if (keyObj && typeof keyObj === 'object') {
                    const draftsTarget = req.target?.drafts ?? req.target?.actives?.drafts;
                    if (draftsTarget) {
                        try {
                            const whereObj = Object.fromEntries(Object.entries(keyObj).filter(([k]) => k !== 'IsActiveEntity'));
                            const draftRow = await cds.run(SELECT.one
                                .from(draftsTarget)
                                .columns(['DraftAdministrativeData_DraftUUID'])
                                .where(whereObj));
                            draftUUID = draftRow?.DraftAdministrativeData_DraftUUID ?? null;
                        }
                        catch (err) {
                            LOG.debug(`${actionName}: could not look up DraftUUID:`, err.message);
                        }
                    }
                }
            }
            if (!draftUUID) {
                LOG.debug(`${actionName} called without DraftUUID — ignoring`);
                return;
            }
            LOG.debug(`${actionName}: user ${req.user.id} joining draft ${draftUUID}`);
            // If Users param is present, this is an explicit invite from the share dialog.
            // Emit event for app code to send notifications, and queue DraftMessages feedback.
            // FE includes the calling user in the Users array (as originator/self).
            // Only treat entries for *other* users as actual invitations.
            const invitedUsers = (req.data?.Users || []).filter((u) => u.UserID !== req.user.id);
            if (invitedUsers.length > 0) {
                LOG.debug(`${actionName}: inviting ${invitedUsers.length} user(s) on behalf of ${req.user.id}`);
                cds.emit(exports.SHARE_INVITE_EVENT, { draftUUID, invitedBy: req.user.id, users: invitedUsers });
                const entityKeyObj = req.params?.[0];
                if (entityKeyObj?.ID) {
                    const msgs = invitedUsers.map(u => ({
                        DraftUUID: draftUUID,
                        FieldName: '',
                        IsActiveEntity: false,
                        Message: `Invitation sent to ${u.UserID}`,
                        NumericSeverity: 1,
                        Target: '',
                        Transition: true
                    }));
                    _pendingInviteMessages.set(entityKeyObj.ID, msgs);
                    // Auto-clear after 15 seconds in case DraftMessages is never read
                    setTimeout(() => _pendingInviteMessages.delete(entityKeyObj.ID), 15000);
                }
            }
            try {
                if (!presence.isParticipant(draftUUID, req.user.id)) {
                    await presence.join(draftUUID, req.user.id, {
                        displayName: getUserDisplayName(req),
                        isOriginator: false
                    });
                }
                else {
                    await presence.heartbeat(draftUUID, req.user.id, getUserDisplayName(req));
                }
                await cds.run(UPDATE('DRAFT.DraftAdministrativeData')
                    .data({ InProcessByUser: '' })
                    .where({ DraftUUID: draftUUID }));
                try {
                    await cds.db.run('UPDATE DRAFT_DraftAdministrativeData SET DraftAccessType = ?, CollaborativeDraftEnabled = 1 WHERE DraftUUID = ?', ['S', draftUUID]);
                }
                catch (err) {
                    LOG.debug('Could not set DraftAccessType in ColDraftShare:', err.message);
                }
                const entityKeyObj = req.params?.[0];
                if (entityKeyObj?.ID) {
                    emitCollabEvent('CollaborativePresenceChanged', shortName, entityKeyObj.ID, { id: req.user?.id, name: getUserDisplayName(req) }).catch(() => { });
                    try {
                        const wsService = await cds.connect.to('CollabDraftWebSocketService').catch(() => null);
                        if (wsService) {
                            const displayName = getUserDisplayName(req);
                            const clientContent = `/${shortName}(ID=${entityKeyObj.ID},IsActiveEntity=false)`;
                            await wsService.emit('message', {
                                userAction: 'JOIN',
                                clientAction: 'JOIN',
                                clientContent,
                                clientTriggeredActionName: '',
                                clientRefreshListBinding: '',
                                clientRequestedProperties: '',
                                userID: req.user.id,
                                userDescription: displayName
                            });
                            const participants = presence.getParticipants(draftUUID);
                            const _mockedUsers = cds.env?.requires?.auth?.users ?? {};
                            for (const p of participants) {
                                if (p.userID === req.user.id)
                                    continue;
                                const pName = _mockedUsers[p.userID]?.displayName || p.displayName || p.userID;
                                await wsService.emit('message', {
                                    userAction: 'JOINECHO',
                                    clientAction: 'JOINECHO',
                                    clientContent,
                                    clientTriggeredActionName: '',
                                    clientRefreshListBinding: '',
                                    clientRequestedProperties: '',
                                    userID: p.userID,
                                    userDescription: pName
                                });
                            }
                        }
                    }
                    catch (err) {
                        LOG.debug('WS JOIN emit failed:', err.message);
                    }
                }
            }
            catch (err) {
                LOG.error(`Error in ${actionName}:`, err.message);
            }
        });
    }
    LOG.debug(`Handlers registered for service ${srv.name}`);
}
/**
 * Checks if a draft UUID has collaborative draft enabled.
 */
async function _isDraftCollaborative(draftUUID) {
    try {
        const rows = await cds.db.run(`SELECT DraftAccessType FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`, [draftUUID]);
        const accessType = Array.isArray(rows) ? rows[0]?.DraftAccessType : rows?.DraftAccessType;
        if (accessType === 'S')
            return true;
    }
    catch (_err) { /* fall through */ }
    if (presence.getParticipants(draftUUID).length > 0)
        return true;
    try {
        const row = await cds.run(SELECT.one.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID }));
        return !!row;
    }
    catch (_err) {
        return false;
    }
}
/**
 * Given a DraftUUID, resolves the root collaborative entity's ID and OData entity set name.
 */
async function _resolveCollabRootContext(draftUUID, srv, collaborativeEntities) {
    for (const entityName of collaborativeEntities) {
        const entity = srv.entities?.[entityName];
        if (!entity)
            continue;
        const draftsTarget = entity.drafts ?? entity;
        try {
            const row = await cds.run(SELECT.one.from(draftsTarget)
                .columns(['ID'])
                .where({ DraftAdministrativeData_DraftUUID: draftUUID }));
            if (row?.ID) {
                return { entitySetName: entityName.split('.').pop(), entityID: row.ID };
            }
        }
        catch (_err) { /* try next */ }
    }
    return null;
}
/**
 * Looks up DraftUUID for the entity referenced in a request.
 */
async function _lookupDraftUUID(req, srv, collaborativeEntities) {
    const keyObj = req.params?.[0];
    if (!keyObj || typeof keyObj !== 'object')
        return null;
    const entityID = keyObj.ID;
    if (!entityID)
        return null;
    const candidates = [
        req.target?.drafts,
        req.target?.actives?.drafts,
        req.target
    ];
    for (const target of candidates) {
        if (!target)
            continue;
        try {
            const row = await cds.run(SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID }));
            if (row?.DraftAdministrativeData_DraftUUID)
                return row.DraftAdministrativeData_DraftUUID;
        }
        catch (_err) { /* try next candidate */ }
    }
    for (const entityName of collaborativeEntities) {
        const entity = srv.entities?.[entityName];
        if (!entity)
            continue;
        for (const target of [entity.drafts, entity]) {
            if (!target)
                continue;
            try {
                const row = await cds.run(SELECT.one.from(target).columns(['DraftAdministrativeData_DraftUUID']).where({ ID: entityID }));
                if (row?.DraftAdministrativeData_DraftUUID)
                    return row.DraftAdministrativeData_DraftUUID;
            }
            catch (_err) { /* try next */ }
        }
    }
    return null;
}
