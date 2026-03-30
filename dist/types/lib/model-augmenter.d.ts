/**
 * Checks if an entity has @CollaborativeDraft.enabled: true
 */
export declare function isCollaborativeDraftEnabled(entity: any): boolean;
/**
 * Finds all entities with @CollaborativeDraft.enabled in the CSN
 */
export declare function findCollaborativeDraftEntities(csn: any): string[];
/**
 * Augments the raw CSN (before compile.for.nodejs) to add our new entities.
 * Called from cds.on('loaded').
 */
export declare function augmentModel(csn: any): void;
/**
 * Augments the compiled model (after cds.compile.for.nodejs) to extend
 * DRAFT.DraftAdministrativeData with CollaborativeDraftEnabled.
 *
 * Called from cds.on('served') where the compiled model is available.
 */
export declare function augmentCompiledModel(model: any): void;
