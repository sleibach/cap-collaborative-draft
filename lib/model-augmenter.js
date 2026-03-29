'use strict'

const cds = require('@sap/cds')
const LOG = cds.log('collab-draft')

/**
 * Patches the lean-draft module's static DRAFT.DraftAdministrativeData definition
 * to add CollaborativeDraftEnabled. This ensures the field appears in the compiled
 * model (after cds.compile.for.nodejs) and thus in $metadata.
 *
 * This is done once at module load time.
 */
function _patchLeanDraftDefinition() {
  try {
    // Access the lean_drafts module's module-level Draft definitions
    const leanDraftsPath = require.resolve('@sap/cds/lib/compile/for/lean_drafts')
    const leanDrafts = require(leanDraftsPath)
    // The module doesn't export the Draft defs directly, but the compiled DRAFT entity
    // is accessible via the module cache. We need to patch it via the cds linked model.
    // Instead, we'll patch the DRAFT.DraftAdministrativeData after compile via served hook.
    // This is a best-effort approach.
  } catch (err) {
    LOG.debug('Could not patch lean-draft definitions:', err.message)
  }
}

/**
 * Checks if an entity has @CollaborativeDraft.enabled: true
 * @param {object} entity - CSN entity definition
 * @returns {boolean}
 */
function isCollaborativeDraftEnabled(entity) {
  return entity?.['@CollaborativeDraft.enabled'] === true
}

/**
 * Finds all entities with @CollaborativeDraft.enabled in the CSN
 * @param {object} csn - compiled CSN model
 * @returns {string[]} entity names
 */
function findCollaborativeDraftEntities(csn) {
  const result = []
  for (const [name, def] of Object.entries(csn.definitions || {})) {
    if (def.kind === 'entity' && isCollaborativeDraftEnabled(def)) {
      // Only root draft-enabled entities
      if (def['@odata.draft.enabled']) {
        result.push(name)
        LOG.info(`Found collaborative draft entity: ${name}`)
      } else {
        LOG.warn(`Entity ${name} has @CollaborativeDraft.enabled but NOT @odata.draft.enabled — collaborative draft ignored`)
      }
    }
  }
  return result
}

/**
 * Augments the raw CSN (before compile.for.nodejs) to add our new entities.
 * Called from cds.on('loaded').
 *
 * Note: DRAFT.DraftAdministrativeData does NOT exist at this stage —
 * it's only created by cds.compile.for.lean_drafts() inside compile.for.nodejs().
 * So we augment it separately in augmentCompiledModel().
 *
 * @param {object} csn - raw compiled CSN model (mutated in place)
 */
function augmentModel(csn) {
  const entities = findCollaborativeDraftEntities(csn)
  if (entities.length === 0) return

  LOG.info(`Augmenting model for ${entities.length} collaborative draft entity(ies)`)

  const defs = csn.definitions

  // Note: DRAFT.DraftAdministrativeUser is NOT injected into raw CSN because
  // the CDS compiler rejects the required Composition on DraftAdministrativeData
  // when the entity is added as a plain JS object (the compiler can't resolve the
  // on-condition nav reference for manually-injected entities).
  // Instead, DraftAdministrativeUser is injected directly into the $metadata XML
  // by the middleware in cds-plugin.js, and into the compiled model by augmentCompiledModel().

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
    }
    LOG.debug('Created DRAFT.DraftParticipants entity')
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
    }
    LOG.debug('Created DRAFT.DraftFieldLocks entity')
  }

  // 3. NOTE: We do NOT pre-define DRAFT.DraftAdministrativeData in raw CSN.
  //    Doing so causes compilation failures:
  //    - The OData transform adds DraftMessages to our entity but expects
  //      DRAFT.DraftAdministrativeData_DraftMessage type to already exist
  //    - cds.minify() strips the manually-added _DraftMessage type since it's
  //      not reachable from any service (it's a root-level type, not an entity)
  //    - The SQL translator recompiles from the CSN and can't find the type
  //
  //    Instead, CollaborativeDraftEnabled and DraftAccessType are added to the
  //    DB table via ALTER TABLE DDL in cds-plugin.js (served hook, after deploy),
  //    and to $metadata XML via the $metadata middleware in cds-plugin.js.

  // 4. For each collaborative draft entity, add @Common.DraftRoot.ShareAction annotation
  // This is in the raw CSN so it appears in the compiled model and $metadata
  for (const entityName of entities) {
    const entity = defs[entityName]
    if (!entity) continue

    // Add ShareAction annotation to signal collaborative draft to Fiori Elements
    if (!entity['@Common.DraftRoot.ShareAction']) {
      entity['@Common.DraftRoot.ShareAction'] = `${entityName.split('.').pop()}_ColDraftShare`
      LOG.debug(`Added @Common.DraftRoot.ShareAction to ${entityName}`)
    }
  }
}

/**
 * Augments the compiled model (after cds.compile.for.nodejs) to extend
 * DRAFT.DraftAdministrativeData with CollaborativeDraftEnabled.
 *
 * Called from cds.on('served') where the compiled model is available.
 *
 * @param {object} model - compiled model (cds.model or service.model)
 */
function augmentCompiledModel(model) {
  if (!model?.definitions) return

  const draftAdmin = model.definitions['DRAFT.DraftAdministrativeData']
  if (!draftAdmin) {
    LOG.debug('DRAFT.DraftAdministrativeData not found in compiled model — skipping')
    return
  }

  // Helper: create an entity definition that inherits from the CDS linked prototype.
  // CAP's runtime (e.g. paging.js) calls methods like def.set() which only exist on
  // the prototype of properly-linked entities. Plain JS objects lack these methods and
  // cause crashes like "def.set is not a function".
  // We borrow the prototype from an existing linked entity in the compiled model.
  const _linkedProto = (() => {
    for (const d of Object.values(model.definitions)) {
      if (d.kind === 'entity' && typeof d.set === 'function') return Object.getPrototypeOf(d)
    }
    return null
  })()

  function _makeLinkedEntity(props) {
    const obj = _linkedProto ? Object.create(_linkedProto) : {}
    return Object.assign(obj, props)
  }

  // 0. Add CollaborativeDraftEnabled and DraftAccessType to DRAFT.DraftAdministrativeData
  //    so that OData $select queries for these fields pass model validation.
  //    The columns themselves are added to the DB via ALTER TABLE in cds-plugin.js.
  if (!draftAdmin.elements.CollaborativeDraftEnabled) {
    draftAdmin.elements.CollaborativeDraftEnabled = {
      name: 'CollaborativeDraftEnabled',
      type: 'cds.Boolean',
      virtual: false
    }
    LOG.debug('Added CollaborativeDraftEnabled element to DRAFT.DraftAdministrativeData compiled model')
  }
  if (!draftAdmin.elements.DraftAccessType) {
    draftAdmin.elements.DraftAccessType = {
      name: 'DraftAccessType',
      type: 'cds.String',
      length: 1,
      virtual: false
    }
    LOG.debug('Added DraftAccessType element to DRAFT.DraftAdministrativeData compiled model')
  }

  // 1. Add DraftAdministrativeUser entity to the compiled model for OData navigation.
  //    This is a virtual entity (no DB table) that Fiori Elements uses to display
  //    participant avatars when @Common.DraftRoot.ShareAction is present.
  //    FE uses: $select=UserID,UserDescription,UserEditingState on this nav prop.
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
    })
    LOG.debug('Added DRAFT.DraftAdministrativeUser to compiled model')
  }

  // 2. Add DraftAdministrativeUser navigation property to DraftAdministrativeData.
  //    virtual: true excludes it from SQL INSERT/UPDATE (like lean_drafts does for DraftAdministrativeData).
  //    '@odata.contained': true makes it an OData containment navigation property in $metadata.
  //    We serve it via a custom READ handler (populated from DRAFT.DraftParticipants).
  //    Note: virtual: true on an association/composition is valid in the COMPILED model
  //    (lean_drafts sets virtual=true on DraftAdministrativeData association at runtime).
  //    _target must be set to the actual entity object so CAP's OData afterburner can
  //    validate $expand=DraftAdministrativeData/DraftAdministrativeUser requests.
  const draftAdminUserEntity = model.definitions['DRAFT.DraftAdministrativeUser']
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
      // _foreignKeys must be an array (empty = no FK propagation needed for this virtual containment).
      // CAP's input.js checks element._foreignKeys.length before calling propagateForeignKeys;
      // if _foreignKeys is undefined, propagateForeignKeys.js crashes with "is not iterable".
      _foreignKeys: [],
      // on is required by foreignKeyPropagations() for is2many elements to compute FK propagations.
      // Empty array means no FK propagation conditions → foreignKeyPropagations() returns [].
      on: []
    }
    LOG.debug('Added DraftAdministrativeUser nav prop to DRAFT.DraftAdministrativeData')
  }

  // 3. Also add to service-projected DraftAdministrativeData entities
  //    The service projection (e.g. OrderService.DraftAdministrativeData) is the entity
  //    the OData afterburner uses for $expand validation, so _target must point to the
  //    service-projected DraftAdministrativeUser entity (with _service set correctly).
  for (const [name, def] of Object.entries(model.definitions)) {
    if (name.endsWith('.DraftAdministrativeData') && !name.startsWith('DRAFT.') && def.elements) {
      // Also expose CollaborativeDraftEnabled and DraftAccessType on service projections
      if (!def.elements.CollaborativeDraftEnabled) {
        def.elements.CollaborativeDraftEnabled = {
          name: 'CollaborativeDraftEnabled',
          type: 'cds.Boolean',
          virtual: false
        }
      }
      if (!def.elements.DraftAccessType) {
        def.elements.DraftAccessType = {
          name: 'DraftAccessType',
          type: 'cds.String',
          length: 1,
          virtual: false
        }
      }

      if (!def.elements.DraftAdministrativeUser) {
        // For service projections, point to the service-projected DraftAdministrativeUser
        const svcName = name.replace('.DraftAdministrativeData', '.DraftAdministrativeUser')

        // Create service DraftAdministrativeUser entity first (needed for _target)
        if (!model.definitions[svcName]) {
          model.definitions[svcName] = _makeLinkedEntity({
            kind: 'entity',
            name: svcName,
            '@cds.persistence.skip': true,
            // Copy _service reference from the parent DraftAdministrativeData so
            // afterburner's service-check (_target._service === target._service) passes
            _service: def._service,
            elements: {
              DraftUUID: { key: true, type: 'cds.UUID', name: 'DraftUUID' },
              UserID: { key: true, type: 'cds.String', length: 256, name: 'UserID' },
              UserDescription: { type: 'cds.String', length: 256, name: 'UserDescription' },
              UserEditingState: { type: 'cds.String', length: 32, name: 'UserEditingState' }
            }
          })
        }

        const svcUserEntity = model.definitions[svcName]
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
          // _foreignKeys must be an array (empty = no FK propagation) to avoid
          // "foreignKeyPropagations is not iterable" crash in propagateForeignKeys.js.
          _foreignKeys: [],
          on: []
        }
        LOG.debug(`Added DraftAdministrativeUser nav prop to ${name}`)
      }
    }
  }

  // 4. Register ColDraftShare bound actions for all entities that have @Common.DraftRoot.ShareAction
  //    Fiori Elements automatically invokes this action when a collaborative draft is opened
  //    to register the current user as a participant. The action must exist in $metadata.
  //    Bound actions in CAP compiled model must be in entity.actions dict (not top-level defs).
  for (const [name, def] of Object.entries(model.definitions)) {
    if (def.kind !== 'entity' || !def['@Common.DraftRoot.ShareAction']) continue
    // Derive the service namespace from the entity's fully qualified name
    // e.g. 'OrderService.Orders' → namespace = 'OrderService'
    const parts = name.split('.')
    const serviceNs = parts.length > 1 ? parts.slice(0, -1).join('.') : null
    // Get the short action name (may already be unqualified from augmentModel)
    const rawActionName = def['@Common.DraftRoot.ShareAction']
    // Use fully qualified name if we have a service namespace and the name isn't already qualified
    const actionShortName = rawActionName.includes('.') ? rawActionName.split('.').pop() : rawActionName
    // Update the annotation to use the fully qualified name so FE's OData V4 model can resolve it
    if (serviceNs && !rawActionName.includes('.')) {
      def['@Common.DraftRoot.ShareAction'] = `${serviceNs}.${rawActionName}`
    }

    if (!def.actions) def.actions = {}
    if (!def.actions[actionShortName]) {
      // FE's addSelf() sends: Users (collection of {UserID}), ShareAll (bool), IsDeltaUpdate (bool).
      // The Users param must reference a complex type so FE can render the value-help.
      // params must be iterable (CAP afterburner calls [...action.params]).
      const params = {
        Users: { type: `${serviceNs}.ColDraftShareUser`, isCollection: true, items: { type: `${serviceNs}.ColDraftShareUser` } },
        ShareAll: { type: 'cds.Boolean' },
        IsDeltaUpdate: { type: 'cds.Boolean' }
      }
      params[Symbol.iterator] = function*() { yield* Object.values(this) }
      def.actions[actionShortName] = {
        kind: 'action',
        name: actionShortName,
        params
      }
      LOG.debug(`Added bound ColDraftShare action ${actionShortName} to entity ${name}`)

      // Register the ColDraftShareUser complex type for the Users parameter value help
      const shareUserTypeName = `${serviceNs}.ColDraftShareUser`
      if (!model.definitions[shareUserTypeName]) {
        model.definitions[shareUserTypeName] = _makeLinkedEntity({
          kind: 'type',
          name: shareUserTypeName,
          elements: {
            UserID: { type: 'cds.String', length: 256, name: 'UserID' }
          }
        })
        LOG.debug(`Added ${shareUserTypeName} complex type`)
      }
    }
  }
}

module.exports = { augmentModel, augmentCompiledModel, findCollaborativeDraftEntities, isCollaborativeDraftEnabled }
