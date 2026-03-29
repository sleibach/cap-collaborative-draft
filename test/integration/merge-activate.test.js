'use strict'

const cds = require('@sap/cds')
const merge = require('../../lib/merge')
const fieldLocks = require('../../lib/field-locks')
const presence = require('../../lib/presence')

cds.test(__dirname + '/../app')

describe('Merge and Activation', () => {
  const baseDraftUUID = 'merge-test-' + Math.random().toString(36).slice(2)
  let testIdx = 0

  function getDraftUUID() {
    return `${baseDraftUUID}-${++testIdx}`
  }

  beforeEach(async () => {
    try {
      await cds.run(DELETE.from('DRAFT.DraftParticipants'))
      await cds.run(DELETE.from('DRAFT.DraftFieldLocks'))
    } catch (e) { /* ignore */ }
  })

  afterEach(async () => {
    // Clear presence store entries for test drafts
    for (const key of presence._store.keys()) {
      if (key.startsWith(baseDraftUUID)) {
        presence._store.delete(key)
      }
    }
  })

  test('validateBeforeActivation passes with no locks', async () => {
    const draftUUID = getDraftUUID()
    const result = await merge.validateBeforeActivation(draftUUID)
    expect(result.valid).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  test('validateBeforeActivation passes with non-conflicting locks', async () => {
    const draftUUID = getDraftUUID()

    // Alice locks Customer, Bob locks Status — no conflicts
    await fieldLocks.acquireLock({
      draftUUID, entityName: 'Orders', entityKey: 'ID=1',
      fieldName: 'Customer', userID: 'alice'
    })
    await fieldLocks.acquireLock({
      draftUUID, entityName: 'Orders', entityKey: 'ID=1',
      fieldName: 'Status', userID: 'bob'
    })

    const result = await merge.validateBeforeActivation(draftUUID)
    expect(result.valid).toBe(true)
  })

  test('cleanup removes participants and locks', async () => {
    const draftUUID = getDraftUUID()

    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })
    await fieldLocks.acquireLock({
      draftUUID, entityName: 'Orders', entityKey: 'ID=1',
      fieldName: 'Customer', userID: 'alice'
    })

    await merge.cleanup(draftUUID)

    // Participants should be gone
    expect(presence.getParticipants(draftUUID)).toHaveLength(0)

    // Locks should be gone
    const locks = await cds.run(
      SELECT.from('DRAFT.DraftFieldLocks').where({ DraftUUID: draftUUID })
    )
    expect(locks).toHaveLength(0)

    // DB participants should be gone
    const dbParticipants = await cds.run(
      SELECT.from('DRAFT.DraftParticipants').where({ DraftUUID: draftUUID })
    )
    expect(dbParticipants).toHaveLength(0)
  })

  test('Two users editing different fields — no conflict', async () => {
    // This tests the field lock check logic
    const draftUUID = getDraftUUID()

    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    // Alice patches Customer
    const aliceResult = await fieldLocks.acquireLocks({
      draftUUID,
      entityName: 'OrderService.Orders',
      entityKey: 'ID=test',
      fieldNames: ['Customer'],
      userID: 'alice'
    })
    expect(aliceResult.acquired).toBe(true)

    // Bob patches Status (different field)
    const bobResult = await fieldLocks.acquireLocks({
      draftUUID,
      entityName: 'OrderService.Orders',
      entityKey: 'ID=test',
      fieldNames: ['Status'],
      userID: 'bob'
    })
    expect(bobResult.acquired).toBe(true)

    // Validation should pass
    const validation = await merge.validateBeforeActivation(draftUUID)
    expect(validation.valid).toBe(true)
  })
})
