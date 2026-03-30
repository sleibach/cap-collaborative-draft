export interface LockConflict {
    fieldName: string;
    lockedBy: string;
}
export interface AcquireResult {
    acquired: boolean;
    lockedBy?: string;
}
export interface AcquireLocksResult {
    acquired: boolean;
    conflicts: LockConflict[];
}
/**
 * Get lock TTL from config or use default
 */
export declare function getLockTtlMs(): number;
/**
 * Attempts to acquire a lock on a field for a user.
 * Fails if another user holds a non-expired lock.
 */
export declare function acquireLock(opts: {
    draftUUID: string;
    entityName: string;
    entityKey: string;
    fieldName: string;
    userID: string;
}): Promise<AcquireResult>;
/**
 * Acquires locks for multiple fields atomically (checks all before acquiring any).
 */
export declare function acquireLocks(opts: {
    draftUUID: string;
    entityName: string;
    entityKey: string;
    fieldNames: string[];
    userID: string;
}): Promise<AcquireLocksResult>;
/**
 * Releases all locks held by a user for a draft.
 */
export declare function releaseLocks(draftUUID: string, userID: string): Promise<void>;
/**
 * Releases ALL locks for a draft (called on activation or full cancel).
 */
export declare function releaseAllLocks(draftUUID: string): Promise<void>;
/**
 * Returns all current (non-expired) locks for a draft.
 */
export declare function getActiveLocks(draftUUID: string): Promise<any[]>;
/**
 * Extracts field names from a PATCH request data object.
 * Ignores draft-internal fields.
 */
export declare function extractPatchedFields(data: Record<string, unknown> | null | undefined): string[];
/**
 * Serializes entity keys to a stable string.
 */
export declare function serializeEntityKey(req: any): string;
