interface ParticipantEntry {
    displayName: string;
    lastSeen: number;
    isOriginator: boolean;
    hasPatched: boolean;
}
export interface ParticipantRecord {
    userID: string;
    displayName: string;
    lastSeen: Date;
    isOriginator: boolean;
    hasPatched: boolean;
}
/**
 * In-memory participant store:
 * Map<draftUUID, Map<userID, ParticipantEntry>>
 */
export declare const _store: Map<string, Map<string, ParticipantEntry>>;
/**
 * Starts the periodic cleanup of stale participants.
 * Safe to call multiple times — only one interval is created.
 */
export declare function startCleanup(): void;
/**
 * Stops the cleanup interval (for testing)
 */
export declare function stopCleanup(): void;
/**
 * Adds or updates a participant in the in-memory store and DB.
 */
export declare function join(draftUUID: string, userID: string, opts?: {
    displayName?: string;
    isOriginator?: boolean;
}): Promise<void>;
/**
 * Updates a participant's lastSeen timestamp (heartbeat).
 * Pass patched=true when called from a PATCH handler to mark that this user has made changes.
 */
export declare function heartbeat(draftUUID: string, userID: string, displayName?: string, patched?: boolean): Promise<void>;
/**
 * Removes a participant from the store (explicit leave).
 */
export declare function leave(draftUUID: string, userID: string): Promise<void>;
/**
 * Removes ALL participants for a draft (on activation or full cancel).
 */
export declare function removeAll(draftUUID: string): Promise<void>;
/**
 * Returns the current participants for a draft.
 */
export declare function getParticipants(draftUUID: string): ParticipantRecord[];
/**
 * Returns whether a user is a participant in a draft.
 */
export declare function isParticipant(draftUUID: string, userID: string): boolean;
/**
 * Returns whether a user is the originator of a draft.
 */
export declare function isOriginator(draftUUID: string, userID: string): boolean;
/**
 * Loads participants from DB into in-memory store (called on bootstrap).
 */
export declare function loadFromDB(): Promise<void>;
export {};
