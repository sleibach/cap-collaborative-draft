'use strict'

const cds = require('@sap/cds')
const LOG = cds.log('collab-draft')

/**
 * Merge strategy: last-write-wins for all fields.
 * Since all participants write directly to the same draft table in CAP,
 * there is no separate "merge" needed — all changes are already in the DB.
 *
 * This module handles post-activation cleanup and validation.
 *
 * For CAP collaborative draft, the "merge" is implicit:
 * - All participants PATCH the same draft rows
 * - Field-level locks ensure no two users edit the same field simultaneously
 * - On activation, the standard CAP draftActivate copies draft data to active tables
 *
 * This module provides:
 * 1. Pre-activation validation (cross-participant consistency checks)
 * 2. Post-activation cleanup of participants and field locks
 */

/**
 * Validates that the draft is in a consistent state before activation.
 * Checks for any remaining field lock conflicts.
 *
 * @param {string} draftUUID
 * @returns {Promise<{ valid: boolean, issues: string[] }>}
 */
async function validateBeforeActivation(draftUUID) {
  const issues = []

  try {
    // Check for stale/conflicting field locks
    const locks = await cds.run(
      SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID })
    )

    if (locks.length > 0) {
      const locksByField = new Map()
      for (const lock of locks) {
        const key = `${lock.EntityName}:${lock.EntityKey}:${lock.FieldName}`
        if (!locksByField.has(key)) locksByField.set(key, [])
        locksByField.get(key).push(lock)
      }

      for (const [key, fieldLocks] of locksByField) {
        if (fieldLocks.length > 1) {
          const users = fieldLocks.map(l => l.LockedBy).join(', ')
          issues.push(`Field ${key} has multiple locks by: ${users}`)
        }
      }
    }
  } catch (err) {
    LOG.warn('Failed to validate before activation:', err.message)
    // Don't block activation on validation errors
  }

  return { valid: issues.length === 0, issues }
}

/**
 * Cleans up all collaborative draft artifacts after activation or full cancellation.
 * @param {string} draftUUID
 */
async function cleanup(draftUUID) {
  const { removeAll } = require('./presence')
  const { releaseAllLocks } = require('./field-locks')

  LOG.info(`Cleaning up collaborative draft artifacts for ${draftUUID}`)

  await Promise.allSettled([
    removeAll(draftUUID),
    releaseAllLocks(draftUUID)
  ])
}

module.exports = { validateBeforeActivation, cleanup }
