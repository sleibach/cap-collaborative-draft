'use strict'

const cds = require('@sap/cds')
const fieldLocks = require('../../dist/lib/field-locks')

cds.test(__dirname + '/../app')

describe('Field-Level Locking', () => {
  const draftUUID = 'test-draft-' + Math.random().toString(36).slice(2)
  const entityName = 'OrderService.Orders'
  const entityKey = 'ID=test-order-1'

  beforeEach(async () => {
    // Clean up locks before each test
    try {
      await cds.run(DELETE.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID }))
    } catch (e) { /* ignore */ }
  })

  test('User A can acquire a lock on field X', async () => {
    const result = await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Customer',
      userID: 'alice'
    })

    expect(result.acquired).toBe(true)
  })

  test('User B is rejected when User A holds a lock on field X', async () => {
    // Alice acquires lock
    await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'NetAmount',
      userID: 'alice'
    })

    // Bob tries to acquire same field
    const result = await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'NetAmount',
      userID: 'bob'
    })

    expect(result.acquired).toBe(false)
    expect(result.lockedBy).toBe('alice')
  })

  test('User B can lock a different field (Y)', async () => {
    // Alice locks Customer
    await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Customer',
      userID: 'alice'
    })

    // Bob locks Status (different field)
    const result = await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Status',
      userID: 'bob'
    })

    expect(result.acquired).toBe(true)
  })

  test('Same user can re-acquire their own lock', async () => {
    await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Notes',
      userID: 'alice'
    })

    const result = await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Notes',
      userID: 'alice'
    })

    expect(result.acquired).toBe(true)
  })

  test('Expired lock can be taken over by another user', async () => {
    // Insert an expired lock directly
    await cds.run(
      INSERT.into('DRAFT.DraftFieldLocks').entries({
        LockID: cds.utils.uuid(),
        DraftUUID: draftUUID,
        EntityName: entityName,
        EntityKey: entityKey,
        FieldName: 'Currency',
        LockedBy: 'alice',
        // 200 seconds ago — beyond default 120s TTL
        LockedAt: new Date(Date.now() - 200_000)
      })
    )

    // Bob should be able to acquire expired lock
    const result = await fieldLocks.acquireLock({
      draftUUID,
      entityName,
      entityKey,
      fieldName: 'Currency',
      userID: 'bob'
    })

    expect(result.acquired).toBe(true)
  })

  test('Bulk lock acquisition — no conflicts', async () => {
    const result = await fieldLocks.acquireLocks({
      draftUUID,
      entityName,
      entityKey,
      fieldNames: ['Customer', 'Status', 'Notes'],
      userID: 'alice'
    })

    expect(result.acquired).toBe(true)
    expect(result.conflicts).toHaveLength(0)
  })

  test('Bulk lock acquisition — with conflicts', async () => {
    // Alice locks two fields
    await fieldLocks.acquireLocks({
      draftUUID,
      entityName,
      entityKey,
      fieldNames: ['Customer', 'Status'],
      userID: 'alice'
    })

    // Bob tries to lock Customer and NetAmount — Customer is blocked
    const result = await fieldLocks.acquireLocks({
      draftUUID,
      entityName,
      entityKey,
      fieldNames: ['Customer', 'NetAmount'],
      userID: 'bob'
    })

    expect(result.acquired).toBe(false)
    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(result.conflicts[0].fieldName).toBe('Customer')
    expect(result.conflicts[0].lockedBy).toBe('alice')
  })

  test('Release locks for a user', async () => {
    await fieldLocks.acquireLocks({
      draftUUID,
      entityName,
      entityKey,
      fieldNames: ['Customer', 'Status'],
      userID: 'alice'
    })

    await fieldLocks.releaseLocks(draftUUID, 'alice')

    // Bob can now lock those fields
    const result = await fieldLocks.acquireLocks({
      draftUUID,
      entityName,
      entityKey,
      fieldNames: ['Customer', 'Status'],
      userID: 'bob'
    })

    expect(result.acquired).toBe(true)
  })

  test('Get active locks excludes expired ones', async () => {
    // Insert one fresh lock
    await fieldLocks.acquireLock({
      draftUUID, entityName, entityKey, fieldName: 'Customer', userID: 'alice'
    })

    // Insert expired lock
    await cds.run(
      INSERT.into('DRAFT.DraftFieldLocks').entries({
        LockID: cds.utils.uuid(),
        DraftUUID: draftUUID,
        EntityName: entityName,
        EntityKey: entityKey,
        FieldName: 'Status',
        LockedBy: 'bob',
        LockedAt: new Date(Date.now() - 200_000) // expired
      })
    )

    const activeLocks = await fieldLocks.getActiveLocks(draftUUID)
    // Only the fresh lock should be returned
    expect(activeLocks.length).toBe(1)
    expect(activeLocks[0].FieldName).toBe('Customer')
  })

  test('extractPatchedFields ignores draft internal fields', () => {
    const data = {
      Customer: 'ACME',
      Status: 'Processing',
      IsActiveEntity: false,
      DraftAdministrativeData_DraftUUID: 'some-uuid',
      HasDraftEntity: true
    }

    const fields = fieldLocks.extractPatchedFields(data)
    expect(fields).toContain('Customer')
    expect(fields).toContain('Status')
    expect(fields).not.toContain('IsActiveEntity')
    expect(fields).not.toContain('DraftAdministrativeData_DraftUUID')
    expect(fields).not.toContain('HasDraftEntity')
  })
})
