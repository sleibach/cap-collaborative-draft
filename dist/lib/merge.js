'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBeforeActivation = validateBeforeActivation;
exports.cleanup = cleanup;
const cds = require("@sap/cds");
const presence_1 = require("./presence");
const field_locks_1 = require("./field-locks");
const LOG = cds.log('collab-draft');
/**
 * Validates that the draft is in a consistent state before activation.
 * Checks for any remaining field lock conflicts.
 */
async function validateBeforeActivation(draftUUID) {
    const issues = [];
    try {
        // Check for stale/conflicting field locks
        const locks = await cds.run(SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID }));
        if (locks.length > 0) {
            const locksByField = new Map();
            for (const lock of locks) {
                const key = `${lock.EntityName}:${lock.EntityKey}:${lock.FieldName}`;
                if (!locksByField.has(key))
                    locksByField.set(key, []);
                locksByField.get(key).push(lock);
            }
            for (const [key, fieldLocks] of locksByField) {
                if (fieldLocks.length > 1) {
                    const users = fieldLocks.map((l) => l.LockedBy).join(', ');
                    issues.push(`Field ${key} has multiple locks by: ${users}`);
                }
            }
        }
    }
    catch (err) {
        LOG.warn('Failed to validate before activation:', err.message);
        // Don't block activation on validation errors
    }
    return { valid: issues.length === 0, issues };
}
/**
 * Cleans up all collaborative draft artifacts after activation or full cancellation.
 */
async function cleanup(draftUUID) {
    LOG.info(`Cleaning up collaborative draft artifacts for ${draftUUID}`);
    await Promise.allSettled([
        (0, presence_1.removeAll)(draftUUID),
        (0, field_locks_1.releaseAllLocks)(draftUUID)
    ]);
}
