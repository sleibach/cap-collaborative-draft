'use strict'

import cds = require('@sap/cds')
import { removeAll } from './presence'
import { releaseAllLocks } from './field-locks'

const LOG = cds.log('collab-draft')

export interface ValidationResult {
  valid: boolean
  issues: string[]
}

/**
 * Validates that the draft is in a consistent state before activation.
 * Checks for any remaining field lock conflicts.
 */
export async function validateBeforeActivation(draftUUID: string): Promise<ValidationResult> {
  const issues: string[] = []

  try {
    // Check for stale/conflicting field locks
    const locks: any[] = await cds.run(
      SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID })
    )

    if (locks.length > 0) {
      const locksByField = new Map<string, any[]>()
      for (const lock of locks) {
        const key = `${lock.EntityName}:${lock.EntityKey}:${lock.FieldName}`
        if (!locksByField.has(key)) locksByField.set(key, [])
        locksByField.get(key)!.push(lock)
      }

      for (const [key, fieldLocks] of locksByField) {
        if (fieldLocks.length > 1) {
          const users = fieldLocks.map((l: any) => l.LockedBy).join(', ')
          issues.push(`Field ${key} has multiple locks by: ${users}`)
        }
      }
    }
  } catch (err: any) {
    LOG.warn('Failed to validate before activation:', err.message)
    // Don't block activation on validation errors
  }

  return { valid: issues.length === 0, issues }
}

/**
 * Cleans up all collaborative draft artifacts after activation or full cancellation.
 */
export async function cleanup(draftUUID: string): Promise<void> {
  LOG.info(`Cleaning up collaborative draft artifacts for ${draftUUID}`)

  await Promise.allSettled([
    removeAll(draftUUID),
    releaseAllLocks(draftUUID)
  ])
}
