/**
 * Event name emitted when ColDraftShare is called with Users to invite.
 * App code can listen: cds.on('collab-draft:shareInvite', ({ draftUUID, invitedBy, users }) => { ... })
 * Each entry in `users` has: { UserID: string, UserAccessRole?: string }
 */
export declare const SHARE_INVITE_EVENT = "collab-draft:shareInvite";
/**
 * Returns all service entities that have @CollaborativeDraft.enabled
 */
export declare function getCollaborativeEntities(srv: any): Set<string>;
/**
 * Registers collaborative draft handlers on a service.
 * Must be called inside srv.prepend() to run before lean-draft handlers.
 */
export declare function registerHandlers(srv: any, collaborativeEntities: Set<string>): void;
