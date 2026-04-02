'use strict'

import cds = require('@sap/cds')
import { collabConfig } from './config'

const LOG = cds.log('collab-draft')

// Default lock TTL (120 seconds)
const DEFAULT_LOCK_TTL_MS = 120 * 1000

export interface LockConflict {
  fieldName: string
  lockedBy: string
}

export interface AcquireResult {
  acquired: boolean
  lockedBy?: string
}

export interface AcquireLocksResult {
  acquired: boolean
  conflicts: LockConflict[]
}

/**
 * Get lock TTL from config or use default
 */
export function getLockTtlMs(): number {
  return collabConfig().fieldLockTtlMs ?? DEFAULT_LOCK_TTL_MS
}

/**
 * Attempts to acquire a lock on a field for a user.
 * Fails if another user holds a non-expired lock.
 */
export async function acquireLock(opts: {
  draftUUID: string
  entityName: string
  entityKey: string
  fieldName: string
  userID: string
}): Promise<AcquireResult> {
  const { draftUUID, entityName, entityKey, fieldName, userID } = opts
  const ttlMs = getLockTtlMs()
  const cutoff = new Date(Date.now() - ttlMs)

  try {
    // Check for existing non-expired lock by a DIFFERENT user
    const existing = await cds.run(
      SELECT.one.from('DRAFT.DraftFieldLocks').where({
        DraftUUID: draftUUID,
        EntityName: entityName,
        EntityKey: entityKey,
        FieldName: fieldName
      })
    )

    if (existing) {
      const lockedAt = new Date(existing.LockedAt)
      const isExpired = lockedAt < cutoff

      if (!isExpired && existing.LockedBy !== userID) {
        // Field is locked by another user
        LOG.debug(`Field ${fieldName} locked by ${existing.LockedBy}, requested by ${userID}`)
        return { acquired: false, lockedBy: existing.LockedBy }
      }

      // Either expired or same user — update the lock
      await cds.run(
        UPDATE('DRAFT.DraftFieldLocks')
          .data({ LockedBy: userID, LockedAt: new Date() })
          .where({ LockID: existing.LockID })
      )
      LOG.debug(`Lock updated: ${fieldName} → ${userID}`)
      return { acquired: true }
    }

    // No existing lock — create new
    await cds.run(
      INSERT.into('DRAFT.DraftFieldLocks').entries({
        LockID: cds.utils.uuid(),
        DraftUUID: draftUUID,
        EntityName: entityName,
        EntityKey: entityKey,
        FieldName: fieldName,
        LockedBy: userID,
        LockedAt: new Date()
      })
    )
    LOG.debug(`Lock acquired: ${fieldName} → ${userID}`)
    return { acquired: true }
  } catch (err: any) {
    LOG.warn('Failed to acquire field lock:', err.message)
    // On DB error, deny the lock — a failed lock check must not silently grant access.
    return { acquired: false }
  }
}

/**
 * Acquires locks for multiple fields atomically (checks all before acquiring any).
 */
export async function acquireLocks(opts: {
  draftUUID: string
  entityName: string
  entityKey: string
  fieldNames: string[]
  userID: string
}): Promise<AcquireLocksResult> {
  const { draftUUID, entityName, entityKey, fieldNames, userID } = opts
  const ttlMs = getLockTtlMs()
  const cutoff = new Date(Date.now() - ttlMs)
  const conflicts: LockConflict[] = []

  try {
    // Get all current locks for these fields in one query
    const existing: any[] = await cds.run(
      SELECT.from('DRAFT.DraftFieldLocks').where({
        DraftUUID: draftUUID,
        EntityName: entityName,
        EntityKey: entityKey,
        FieldName: { in: fieldNames }
      })
    )

    const lockMap = new Map<string, any>(existing.map((l: any) => [l.FieldName, l]))

    // Check for conflicts
    for (const fieldName of fieldNames) {
      const lock = lockMap.get(fieldName)
      if (!lock) continue
      const isExpired = new Date(lock.LockedAt) < cutoff
      if (!isExpired && lock.LockedBy !== userID) {
        conflicts.push({ fieldName, lockedBy: lock.LockedBy })
      }
    }

    if (conflicts.length > 0) {
      return { acquired: false, conflicts }
    }

    // No conflicts — acquire/update all locks
    const now = new Date()
    for (const fieldName of fieldNames) {
      const existingLock = lockMap.get(fieldName)
      if (existingLock) {
        await cds.run(
          UPDATE('DRAFT.DraftFieldLocks')
            .data({ LockedBy: userID, LockedAt: now })
            .where({ LockID: existingLock.LockID })
        )
      } else {
        await cds.run(
          INSERT.into('DRAFT.DraftFieldLocks').entries({
            LockID: cds.utils.uuid(),
            DraftUUID: draftUUID,
            EntityName: entityName,
            EntityKey: entityKey,
            FieldName: fieldName,
            LockedBy: userID,
            LockedAt: now
          })
        )
      }
    }

    return { acquired: true, conflicts: [] }
  } catch (err: any) {
    LOG.warn('Failed to acquire field locks:', err.message)
    // On DB error, deny all locks — a failed lock check must not silently grant access.
    return { acquired: false, conflicts: [] }
  }
}

/**
 * Releases all locks held by a user for a draft.
 */
export async function releaseLocks(draftUUID: string, userID: string): Promise<void> {
  try {
    await cds.run(
      DELETE.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID, LockedBy: userID })
    )
    LOG.debug(`Released all locks for ${userID} on draft ${draftUUID}`)
  } catch (err: any) {
    LOG.warn('Failed to release field locks:', err.message)
  }
}

/**
 * Releases ALL locks for a draft (called on activation or full cancel).
 */
export async function releaseAllLocks(draftUUID: string): Promise<void> {
  try {
    await cds.run(DELETE.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID }))
    LOG.debug(`Released all locks for draft ${draftUUID}`)
  } catch (err: any) {
    LOG.warn('Failed to release all field locks:', err.message)
  }
}

/**
 * Returns all current (non-expired) locks for a draft.
 */
export async function getActiveLocks(draftUUID: string): Promise<any[]> {
  const ttlMs = getLockTtlMs()
  const cutoff = new Date(Date.now() - ttlMs)
  try {
    const locks: any[] = await cds.run(
      SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID })
    )
    return locks.filter((l: any) => new Date(l.LockedAt) >= cutoff)
  } catch (err: any) {
    LOG.warn('Failed to get active locks:', err.message)
    return []
  }
}

/**
 * Extracts field names from a PATCH request data object.
 * Ignores draft-internal fields.
 */
export function extractPatchedFields(data: Record<string, unknown> | null | undefined): string[] {
  // Exclude: draft system fields, primary keys, foreign keys, audit fields
  const excludedFields = new Set([
    'IsActiveEntity', 'HasDraftEntity', 'HasActiveEntity',
    'DraftAdministrativeData_DraftUUID', 'DraftAdministrativeData',
    'ID',
    'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'
  ])
  return Object.keys(data || {}).filter(k => {
    if (excludedFields.has(k)) return false
    // Exclude raw FK columns that end in _ID (association foreign keys)
    if (k.endsWith('_ID') || k.endsWith('_id')) return false
    return true
  })
}

/**
 * Serializes entity keys to a stable string.
 */
export function serializeEntityKey(req: any): string {
  const keys = req.params?.[req.params.length - 1] || {}
  if (typeof keys === 'object') {
    return Object.entries(keys)
      .sort(([a], [b]) => (a as string).localeCompare(b as string))
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
  }
  return String(keys)
}
