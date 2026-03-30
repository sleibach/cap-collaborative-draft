/**
 * Returns all service entities that have @CollaborativeDraft.enabled
 */
export declare function getCollaborativeEntities(srv: any): Set<string>;
/**
 * Registers collaborative draft handlers on a service.
 * Must be called inside srv.prepend() to run before lean-draft handlers.
 */
export declare function registerHandlers(srv: any, collaborativeEntities: Set<string>): void;
