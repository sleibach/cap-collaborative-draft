'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCollaborativeDraftEnabled = isCollaborativeDraftEnabled;
exports.findCollaborativeDraftEntities = findCollaborativeDraftEntities;
exports.augmentModel = augmentModel;
exports.augmentCompiledModel = augmentCompiledModel;
const cds = require("@sap/cds");
const LOG = cds.log('collab-draft');
/**
 * Checks if an entity has @CollaborativeDraft.enabled: true
 */
function isCollaborativeDraftEnabled(entity) {
    return entity?.['@CollaborativeDraft.enabled'] === true;
}
/**
 * Finds all entities with @CollaborativeDraft.enabled in the CSN
 */
function findCollaborativeDraftEntities(csn) {
    const result = [];
    for (const [name, def] of Object.entries(csn.definitions || {})) {
        if (def.kind === 'entity' && isCollaborativeDraftEnabled(def)) {
            // Only root draft-enabled entities
            if (def['@odata.draft.enabled']) {
                result.push(name);
                LOG.info(`Found collaborative draft entity: ${name}`);
            }
            else {
                LOG.warn(`Entity ${name} has @CollaborativeDraft.enabled but NOT @odata.draft.enabled — collaborative draft ignored`);
            }
        }
    }
    return result;
}
/**
 * Augments the raw CSN (before compile.for.nodejs) to add our new entities.
 * Called from cds.on('loaded').
 */
function augmentModel(csn) {
    const entities = findCollaborativeDraftEntities(csn);
    if (entities.length === 0)
        return;
    LOG.info(`Augmenting model for ${entities.length} collaborative draft entity(ies)`);
    const defs = csn.definitions;
    // 1. Create DRAFT.DraftParticipants entity if it doesn't exist
    if (!defs['DRAFT.DraftParticipants']) {
        defs['DRAFT.DraftParticipants'] = {
            kind: 'entity',
            '@cds.persistence.skip': false,
            elements: {
                ParticipantID: {
                    key: true,
                    type: 'cds.UUID',
                    '@Core.Computed': true
                },
                DraftUUID: {
                    type: 'cds.UUID'
                },
                UserID: {
                    type: 'cds.String',
                    length: 256
                },
                UserDescription: {
                    type: 'cds.String',
                    length: 256
                },
                LastSeenAt: {
                    type: 'cds.Timestamp'
                },
                IsOriginator: {
                    type: 'cds.Boolean'
                }
            }
        };
        LOG.debug('Created DRAFT.DraftParticipants entity');
    }
    // 2. Create DRAFT.DraftFieldLocks entity if it doesn't exist
    if (!defs['DRAFT.DraftFieldLocks']) {
        defs['DRAFT.DraftFieldLocks'] = {
            kind: 'entity',
            '@cds.persistence.skip': false,
            elements: {
                LockID: {
                    key: true,
                    type: 'cds.UUID',
                    '@Core.Computed': true
                },
                DraftUUID: {
                    type: 'cds.UUID'
                },
                EntityName: {
                    type: 'cds.String',
                    length: 256
                },
                EntityKey: {
                    type: 'cds.String',
                    length: 500
                },
                FieldName: {
                    type: 'cds.String',
                    length: 256
                },
                LockedBy: {
                    type: 'cds.String',
                    length: 256
                },
                LockedAt: {
                    type: 'cds.Timestamp'
                }
            }
        };
        LOG.debug('Created DRAFT.DraftFieldLocks entity');
    }
    // 3. NOTE: We do NOT pre-define DRAFT.DraftAdministrativeData in raw CSN.
    //    CollaborativeDraftEnabled and DraftAccessType are added to the DB table via
    //    ALTER TABLE DDL in cds-plugin.ts, and to $metadata XML via the $metadata middleware.
    // 4. For each collaborative draft entity, add @Common.DraftRoot.ShareAction annotation
    for (const entityName of entities) {
        const entity = defs[entityName];
        if (!entity)
            continue;
        if (!entity['@Common.DraftRoot.ShareAction']) {
            entity['@Common.DraftRoot.ShareAction'] = `${entityName.split('.').pop()}_ColDraftShare`;
            LOG.debug(`Added @Common.DraftRoot.ShareAction to ${entityName}`);
        }
    }
}
/**
 * Augments the compiled model (after cds.compile.for.nodejs) to extend
 * DRAFT.DraftAdministrativeData with CollaborativeDraftEnabled.
 *
 * Called from cds.on('served') where the compiled model is available.
 */
function augmentCompiledModel(model) {
    if (!model?.definitions)
        return;
    const draftAdmin = model.definitions['DRAFT.DraftAdministrativeData'];
    if (!draftAdmin) {
        LOG.debug('DRAFT.DraftAdministrativeData not found in compiled model — skipping');
        return;
    }
    // Helper: create an entity definition that inherits from the CDS linked prototype.
    const _linkedProto = (() => {
        for (const d of Object.values(model.definitions)) {
            if (d.kind === 'entity' && typeof d.set === 'function')
                return Object.getPrototypeOf(d);
        }
        return null;
    })();
    function _makeLinkedEntity(props) {
        const obj = _linkedProto ? Object.create(_linkedProto) : {};
        return Object.assign(obj, props);
    }
    // 0. Add CollaborativeDraftEnabled and DraftAccessType to DRAFT.DraftAdministrativeData
    if (!draftAdmin.elements.CollaborativeDraftEnabled) {
        draftAdmin.elements.CollaborativeDraftEnabled = {
            name: 'CollaborativeDraftEnabled',
            type: 'cds.Boolean',
            virtual: false
        };
        LOG.debug('Added CollaborativeDraftEnabled element to DRAFT.DraftAdministrativeData compiled model');
    }
    if (!draftAdmin.elements.DraftAccessType) {
        draftAdmin.elements.DraftAccessType = {
            name: 'DraftAccessType',
            type: 'cds.String',
            length: 1,
            virtual: false
        };
        LOG.debug('Added DraftAccessType element to DRAFT.DraftAdministrativeData compiled model');
    }
    // 1. Add DraftAdministrativeUser entity to the compiled model for OData navigation.
    if (!model.definitions['DRAFT.DraftAdministrativeUser']) {
        model.definitions['DRAFT.DraftAdministrativeUser'] = _makeLinkedEntity({
            kind: 'entity',
            name: 'DRAFT.DraftAdministrativeUser',
            '@cds.persistence.skip': true,
            elements: {
                DraftUUID: { key: true, type: 'cds.UUID', name: 'DraftUUID' },
                UserID: { key: true, type: 'cds.String', length: 256, name: 'UserID' },
                UserDescription: { type: 'cds.String', length: 256, name: 'UserDescription' },
                UserEditingState: { type: 'cds.String', length: 32, name: 'UserEditingState' }
            }
        });
        LOG.debug('Added DRAFT.DraftAdministrativeUser to compiled model');
    }
    // 2. Add DraftAdministrativeUser navigation property to DraftAdministrativeData.
    const draftAdminUserEntity = model.definitions['DRAFT.DraftAdministrativeUser'];
    if (!draftAdmin.elements.DraftAdministrativeUser && draftAdminUserEntity) {
        draftAdmin.elements.DraftAdministrativeUser = {
            name: 'DraftAdministrativeUser',
            type: 'cds.Composition',
            cardinality: { max: '*' },
            target: 'DRAFT.DraftAdministrativeUser',
            _target: draftAdminUserEntity,
            isComposition: true,
            isAssociation: true,
            is2many: true,
            virtual: true,
            '@odata.contained': true,
            _foreignKeys: [],
            on: []
        };
        LOG.debug('Added DraftAdministrativeUser nav prop to DRAFT.DraftAdministrativeData');
    }
    // 3. Also add to service-projected DraftAdministrativeData entities
    for (const [name, def] of Object.entries(model.definitions)) {
        if (name.endsWith('.DraftAdministrativeData') && !name.startsWith('DRAFT.') && def.elements) {
            // Also expose CollaborativeDraftEnabled and DraftAccessType on service projections
            if (!def.elements.CollaborativeDraftEnabled) {
                def.elements.CollaborativeDraftEnabled = {
                    name: 'CollaborativeDraftEnabled',
                    type: 'cds.Boolean',
                    virtual: false
                };
            }
            if (!def.elements.DraftAccessType) {
                def.elements.DraftAccessType = {
                    name: 'DraftAccessType',
                    type: 'cds.String',
                    length: 1,
                    virtual: false
                };
            }
            if (!def.elements.DraftAdministrativeUser) {
                const svcName = name.replace('.DraftAdministrativeData', '.DraftAdministrativeUser');
                if (!model.definitions[svcName]) {
                    model.definitions[svcName] = _makeLinkedEntity({
                        kind: 'entity',
                        name: svcName,
                        '@cds.persistence.skip': true,
                        _service: def._service,
                        elements: {
                            DraftUUID: { key: true, type: 'cds.UUID', name: 'DraftUUID' },
                            UserID: { key: true, type: 'cds.String', length: 256, name: 'UserID' },
                            UserDescription: { type: 'cds.String', length: 256, name: 'UserDescription' },
                            UserEditingState: { type: 'cds.String', length: 32, name: 'UserEditingState' }
                        }
                    });
                }
                const svcUserEntity = model.definitions[svcName];
                def.elements.DraftAdministrativeUser = {
                    name: 'DraftAdministrativeUser',
                    type: 'cds.Composition',
                    cardinality: { max: '*' },
                    target: svcName,
                    _target: svcUserEntity,
                    isComposition: true,
                    isAssociation: true,
                    is2many: true,
                    virtual: true,
                    '@odata.contained': true,
                    _foreignKeys: [],
                    on: []
                };
                LOG.debug(`Added DraftAdministrativeUser nav prop to ${name}`);
            }
        }
    }
    // 4. Register ColDraftShare bound actions for all entities that have @Common.DraftRoot.ShareAction
    for (const [name, def] of Object.entries(model.definitions)) {
        if (def.kind !== 'entity' || !def['@Common.DraftRoot.ShareAction'])
            continue;
        const parts = name.split('.');
        const serviceNs = parts.length > 1 ? parts.slice(0, -1).join('.') : null;
        const rawActionName = def['@Common.DraftRoot.ShareAction'];
        const actionShortName = rawActionName.includes('.') ? rawActionName.split('.').pop() : rawActionName;
        if (serviceNs && !rawActionName.includes('.')) {
            def['@Common.DraftRoot.ShareAction'] = `${serviceNs}.${rawActionName}`;
        }
        if (!def.actions)
            def.actions = {};
        if (!def.actions[actionShortName]) {
            const params = {
                Users: { type: `${serviceNs}.ColDraftShareUser`, isCollection: true, items: { type: `${serviceNs}.ColDraftShareUser` } },
                ShareAll: { type: 'cds.Boolean' },
                IsDeltaUpdate: { type: 'cds.Boolean' }
            };
            params[Symbol.iterator] = function* () { yield* Object.values(this); };
            def.actions[actionShortName] = {
                kind: 'action',
                name: actionShortName,
                params
            };
            LOG.debug(`Added bound ColDraftShare action ${actionShortName} to entity ${name}`);
            const shareUserTypeName = `${serviceNs}.ColDraftShareUser`;
            if (!model.definitions[shareUserTypeName]) {
                model.definitions[shareUserTypeName] = _makeLinkedEntity({
                    kind: 'type',
                    name: shareUserTypeName,
                    elements: {
                        UserID: { type: 'cds.String', length: 256, name: 'UserID' },
                        UserAccessRole: { type: 'cds.String', length: 1, name: 'UserAccessRole' }
                    }
                });
                LOG.debug(`Added ${shareUserTypeName} complex type`);
            }
        }
    }
}
