'use strict'

/**
 * Patches the lean_drafts module's static DRAFT.DraftAdministrativeData definition
 * to add CollaborativeDraftEnabled.
 *
 * This must be called BEFORE lean_drafts is first loaded (i.e., before the first
 * call to cds.compile.for.nodejs). Since cds-plugin.js is loaded at startup before
 * any model compilation, this works correctly.
 *
 * Strategy: intercept cds.linked() once to capture and mutate the DRAFT.DraftAdministrativeData
 * definition from lean_drafts' module-level initialization.
 */
module.exports = function patchDraftAdminData(cds, LOG) {
  const leanDraftsPath = (() => {
    try { return require.resolve('@sap/cds/lib/compile/for/lean_drafts') }
    catch (e) { return null }
  })()

  if (!leanDraftsPath) {
    LOG.warn('Could not find lean_drafts module — CollaborativeDraftEnabled not added to $metadata')
    return
  }

  // If lean_drafts is already loaded, the cds.linked() call already happened
  if (require.cache[leanDraftsPath]) {
    LOG.debug('lean_drafts already loaded — patching existing DRAFT.DraftAdministrativeData definition')
    // Try to access the cached module
    const cachedModule = require.cache[leanDraftsPath]
    // The module doesn't export the Draft definitions, but we can reload it with interception
    // This is a no-op for now — we fall back to augmentCompiledModel() in served hook
    return
  }

  // lean_drafts not yet loaded — intercept cds.linked() to capture the DraftAdministrativeData def
  const origLinked = cds.linked.bind(cds)
  let intercepted = false

  cds.linked = function interceptLinked(...args) {
    const result = origLinked(...args)

    if (!intercepted && result?.definitions?.['DRAFT.DraftAdministrativeData']) {
      intercepted = true
      // Restore original immediately to avoid infinite recursion
      cds.linked = origLinked

      const draftAdminDef = result.definitions['DRAFT.DraftAdministrativeData']

      if (!draftAdminDef.elements.CollaborativeDraftEnabled) {
        draftAdminDef.elements.CollaborativeDraftEnabled = {
          type: 'cds.Boolean',
          default: { val: false }
        }
        LOG.debug('Patched DRAFT.DraftAdministrativeData with CollaborativeDraftEnabled (via cds.linked intercept)')
      }
    }

    return result
  }

  LOG.debug('Interceptor registered for DRAFT.DraftAdministrativeData patching')
}
