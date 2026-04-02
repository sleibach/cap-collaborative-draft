'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports._store = void 0;
exports.startCleanup = startCleanup;
exports.stopCleanup = stopCleanup;
exports.join = join;
exports.heartbeat = heartbeat;
exports.leave = leave;
exports.removeAll = removeAll;
exports.getParticipants = getParticipants;
exports.isParticipant = isParticipant;
exports.isOriginator = isOriginator;
exports.loadFromDB = loadFromDB;
const cds = require("@sap/cds");
const config_1 = require("./config");
const LOG = cds.log('collab-draft');
// Default TTL for participants (5 minutes of inactivity)
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// Cleanup interval (30 seconds)
const CLEANUP_INTERVAL_MS = 30 * 1000;
/**
 * In-memory participant store:
 * Map<draftUUID, Map<userID, ParticipantEntry>>
 */
exports._store = new Map();
/** Cleanup interval timer reference */
let _cleanupTimer = null;
/**
 * Get TTL from config or use default
 */
function getTtlMs() {
    return (0, config_1.collabConfig)().presenceTtlMs ?? DEFAULT_TTL_MS;
}
/**
 * Starts the periodic cleanup of stale participants.
 * Safe to call multiple times — only one interval is created.
 */
function startCleanup() {
    if (_cleanupTimer)
        return;
    _cleanupTimer = setInterval(() => {
        const ttl = getTtlMs();
        const cutoff = Date.now() - ttl;
        for (const [draftUUID, participants] of exports._store) {
            for (const [userID, info] of participants) {
                if (info.lastSeen < cutoff) {
                    LOG.debug(`Removing stale participant ${userID} from draft ${draftUUID}`);
                    participants.delete(userID);
                    // Also remove from DB (fire and forget)
                    _removeParticipantFromDB(draftUUID, userID).catch((err) => LOG.warn('Failed to remove stale participant from DB:', err.message));
                }
            }
            if (participants.size === 0) {
                exports._store.delete(draftUUID);
            }
        }
    }, CLEANUP_INTERVAL_MS);
    // Don't block process exit
    if (typeof _cleanupTimer.unref === 'function') {
        _cleanupTimer.unref();
    }
}
/**
 * Stops the cleanup interval (for testing)
 */
function stopCleanup() {
    if (_cleanupTimer) {
        clearInterval(_cleanupTimer);
        _cleanupTimer = null;
    }
}
/**
 * Adds or updates a participant in the in-memory store and DB.
 */
async function join(draftUUID, userID, opts = {}) {
    const { displayName = userID, isOriginator = false } = opts;
    // In-memory
    if (!exports._store.has(draftUUID))
        exports._store.set(draftUUID, new Map());
    const participants = exports._store.get(draftUUID);
    const existing = participants.get(userID);
    participants.set(userID, {
        displayName,
        lastSeen: Date.now(),
        isOriginator: existing?.isOriginator ?? isOriginator
    });
    LOG.debug(`Participant joined: ${userID} → draft ${draftUUID} (originator=${isOriginator})`);
    // Persist to DB
    await _upsertParticipantInDB(draftUUID, userID, displayName, existing?.isOriginator ?? isOriginator);
}
/**
 * Updates a participant's lastSeen timestamp (heartbeat).
 */
async function heartbeat(draftUUID, userID, displayName) {
    const participants = exports._store.get(draftUUID);
    if (!participants)
        return;
    const p = participants.get(userID);
    if (!p)
        return;
    p.lastSeen = Date.now();
    if (displayName)
        p.displayName = displayName;
    // Update DB
    await _upsertParticipantInDB(draftUUID, userID, p.displayName, p.isOriginator);
}
/**
 * Removes a participant from the store (explicit leave).
 */
async function leave(draftUUID, userID) {
    const participants = exports._store.get(draftUUID);
    if (participants) {
        participants.delete(userID);
        if (participants.size === 0)
            exports._store.delete(draftUUID);
    }
    LOG.debug(`Participant left: ${userID} → draft ${draftUUID}`);
    await _removeParticipantFromDB(draftUUID, userID);
}
/**
 * Removes ALL participants for a draft (on activation or full cancel).
 */
async function removeAll(draftUUID) {
    exports._store.delete(draftUUID);
    LOG.debug(`All participants removed for draft ${draftUUID}`);
    try {
        await cds.run(DELETE.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID }));
    }
    catch (err) {
        LOG.warn('Failed to remove all participants from DB:', err.message);
    }
}
/**
 * Returns the current participants for a draft.
 */
function getParticipants(draftUUID) {
    const participants = exports._store.get(draftUUID);
    if (!participants)
        return [];
    return Array.from(participants.entries()).map(([userID, info]) => ({
        userID,
        displayName: info.displayName,
        lastSeen: new Date(info.lastSeen),
        isOriginator: info.isOriginator
    }));
}
/**
 * Returns whether a user is a participant in a draft.
 */
function isParticipant(draftUUID, userID) {
    return exports._store.get(draftUUID)?.has(userID) ?? false;
}
/**
 * Returns whether a user is the originator of a draft.
 */
function isOriginator(draftUUID, userID) {
    return exports._store.get(draftUUID)?.get(userID)?.isOriginator === true;
}
/**
 * Loads participants from DB into in-memory store (called on bootstrap).
 */
async function loadFromDB() {
    try {
        const rows = await cds.run(SELECT.from('DRAFT.DraftParticipants'));
        for (const row of rows) {
            if (!exports._store.has(row.DraftUUID))
                exports._store.set(row.DraftUUID, new Map());
            exports._store.get(row.DraftUUID).set(row.UserID, {
                displayName: row.UserDescription || row.UserID,
                lastSeen: row.LastSeenAt ? new Date(row.LastSeenAt).getTime() : Date.now(),
                isOriginator: row.IsOriginator === true || row.IsOriginator === 1
            });
        }
        if (rows.length > 0)
            LOG.debug(`Loaded ${rows.length} participants from DB`);
    }
    catch (err) {
        LOG.warn('Failed to load participants from DB (table may not exist yet):', err.message);
    }
}
// ---- DB persistence helpers ----
async function _upsertParticipantInDB(draftUUID, userID, displayName, isOrig) {
    try {
        // Try update first
        const updated = await cds.run(UPDATE('DRAFT.DraftParticipants')
            .data({ UserDescription: displayName, LastSeenAt: new Date(), IsOriginator: isOrig })
            .where({ DraftUUID: draftUUID, UserID: userID }));
        if (!updated) {
            // Insert if not found
            await cds.run(INSERT.into('DRAFT.DraftParticipants').entries({
                ParticipantID: cds.utils.uuid(),
                DraftUUID: draftUUID,
                UserID: userID,
                UserDescription: displayName,
                LastSeenAt: new Date(),
                IsOriginator: isOrig
            }));
        }
    }
    catch (err) {
        LOG.warn('Failed to upsert participant in DB:', err.message);
    }
}
async function _removeParticipantFromDB(draftUUID, userID) {
    try {
        await cds.run(DELETE.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID, UserID: userID }));
    }
    catch (err) {
        LOG.warn('Failed to remove participant from DB:', err.message);
    }
}
