'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLockTtlMs = getLockTtlMs;
exports.acquireLock = acquireLock;
exports.acquireLocks = acquireLocks;
exports.releaseLocks = releaseLocks;
exports.releaseAllLocks = releaseAllLocks;
exports.getActiveLocks = getActiveLocks;
exports.extractPatchedFields = extractPatchedFields;
exports.serializeEntityKey = serializeEntityKey;
const cds = require("@sap/cds");
const LOG = cds.log('collab-draft');
// Default lock TTL (120 seconds)
const DEFAULT_LOCK_TTL_MS = 120 * 1000;
/**
 * Get lock TTL from config or use default
 */
function getLockTtlMs() {
    return cds.env.collab?.fieldLockTtlMs ?? DEFAULT_LOCK_TTL_MS;
}
/**
 * Attempts to acquire a lock on a field for a user.
 * Fails if another user holds a non-expired lock.
 */
async function acquireLock(opts) {
    const { draftUUID, entityName, entityKey, fieldName, userID } = opts;
    const ttlMs = getLockTtlMs();
    const cutoff = new Date(Date.now() - ttlMs);
    try {
        // Check for existing non-expired lock by a DIFFERENT user
        const existing = await cds.run(SELECT.one.from('DRAFT.DraftFieldLocks').where({
            DraftUUID: draftUUID,
            EntityName: entityName,
            EntityKey: entityKey,
            FieldName: fieldName
        }));
        if (existing) {
            const lockedAt = new Date(existing.LockedAt);
            const isExpired = lockedAt < cutoff;
            if (!isExpired && existing.LockedBy !== userID) {
                // Field is locked by another user
                LOG.debug(`Field ${fieldName} locked by ${existing.LockedBy}, requested by ${userID}`);
                return { acquired: false, lockedBy: existing.LockedBy };
            }
            // Either expired or same user — update the lock
            await cds.run(UPDATE('DRAFT.DraftFieldLocks')
                .data({ LockedBy: userID, LockedAt: new Date() })
                .where({ LockID: existing.LockID }));
            LOG.debug(`Lock updated: ${fieldName} → ${userID}`);
            return { acquired: true };
        }
        // No existing lock — create new
        await cds.run(INSERT.into('DRAFT.DraftFieldLocks').entries({
            LockID: cds.utils.uuid(),
            DraftUUID: draftUUID,
            EntityName: entityName,
            EntityKey: entityKey,
            FieldName: fieldName,
            LockedBy: userID,
            LockedAt: new Date()
        }));
        LOG.debug(`Lock acquired: ${fieldName} → ${userID}`);
        return { acquired: true };
    }
    catch (err) {
        LOG.warn('Failed to acquire field lock:', err.message);
        // On DB error, be permissive — don't block the user
        return { acquired: true };
    }
}
/**
 * Acquires locks for multiple fields atomically (checks all before acquiring any).
 */
async function acquireLocks(opts) {
    const { draftUUID, entityName, entityKey, fieldNames, userID } = opts;
    const ttlMs = getLockTtlMs();
    const cutoff = new Date(Date.now() - ttlMs);
    const conflicts = [];
    try {
        // Get all current locks for these fields in one query
        const existing = await cds.run(SELECT.from('DRAFT.DraftFieldLocks').where({
            DraftUUID: draftUUID,
            EntityName: entityName,
            EntityKey: entityKey,
            FieldName: { in: fieldNames }
        }));
        const lockMap = new Map(existing.map((l) => [l.FieldName, l]));
        // Check for conflicts
        for (const fieldName of fieldNames) {
            const lock = lockMap.get(fieldName);
            if (!lock)
                continue;
            const isExpired = new Date(lock.LockedAt) < cutoff;
            if (!isExpired && lock.LockedBy !== userID) {
                conflicts.push({ fieldName, lockedBy: lock.LockedBy });
            }
        }
        if (conflicts.length > 0) {
            return { acquired: false, conflicts };
        }
        // No conflicts — acquire/update all locks
        const now = new Date();
        for (const fieldName of fieldNames) {
            const existingLock = lockMap.get(fieldName);
            if (existingLock) {
                await cds.run(UPDATE('DRAFT.DraftFieldLocks')
                    .data({ LockedBy: userID, LockedAt: now })
                    .where({ LockID: existingLock.LockID }));
            }
            else {
                await cds.run(INSERT.into('DRAFT.DraftFieldLocks').entries({
                    LockID: cds.utils.uuid(),
                    DraftUUID: draftUUID,
                    EntityName: entityName,
                    EntityKey: entityKey,
                    FieldName: fieldName,
                    LockedBy: userID,
                    LockedAt: now
                }));
            }
        }
        return { acquired: true, conflicts: [] };
    }
    catch (err) {
        LOG.warn('Failed to acquire field locks:', err.message);
        return { acquired: true, conflicts: [] };
    }
}
/**
 * Releases all locks held by a user for a draft.
 */
async function releaseLocks(draftUUID, userID) {
    try {
        await cds.run(DELETE.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID, LockedBy: userID }));
        LOG.debug(`Released all locks for ${userID} on draft ${draftUUID}`);
    }
    catch (err) {
        LOG.warn('Failed to release field locks:', err.message);
    }
}
/**
 * Releases ALL locks for a draft (called on activation or full cancel).
 */
async function releaseAllLocks(draftUUID) {
    try {
        await cds.run(DELETE.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID }));
        LOG.debug(`Released all locks for draft ${draftUUID}`);
    }
    catch (err) {
        LOG.warn('Failed to release all field locks:', err.message);
    }
}
/**
 * Returns all current (non-expired) locks for a draft.
 */
async function getActiveLocks(draftUUID) {
    const ttlMs = getLockTtlMs();
    const cutoff = new Date(Date.now() - ttlMs);
    try {
        const locks = await cds.run(SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID }));
        return locks.filter((l) => new Date(l.LockedAt) >= cutoff);
    }
    catch (err) {
        LOG.warn('Failed to get active locks:', err.message);
        return [];
    }
}
/**
 * Extracts field names from a PATCH request data object.
 * Ignores draft-internal fields.
 */
function extractPatchedFields(data) {
    // Exclude: draft system fields, primary keys, foreign keys, audit fields
    const excludedFields = new Set([
        'IsActiveEntity', 'HasDraftEntity', 'HasActiveEntity',
        'DraftAdministrativeData_DraftUUID', 'DraftAdministrativeData',
        'ID',
        'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
    ]);
    return Object.keys(data || {}).filter(k => {
        if (excludedFields.has(k))
            return false;
        // Exclude raw FK columns that end in _ID (association foreign keys)
        if (k.endsWith('_ID') || k.endsWith('_id'))
            return false;
        return true;
    });
}
/**
 * Serializes entity keys to a stable string.
 */
function serializeEntityKey(req) {
    const keys = req.params?.[req.params.length - 1] || {};
    if (typeof keys === 'object') {
        return Object.entries(keys)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',');
    }
    return String(keys);
}
