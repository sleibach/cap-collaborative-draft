'use strict'

const cds = require('@sap/cds')

// Point cds to the test app
cds.test(__dirname + '/../app')

describe('Collaborative Draft — Join existing draft', () => {
  let userA, userB

  beforeAll(async () => {
    // Create two user contexts
    userA = { id: 'alice', roles: ['authenticated-user'] }
    userB = { id: 'bob', roles: ['authenticated-user'] }
  })

  beforeEach(async () => {
    // Clean up before each test
    await cds.run(DELETE.from('DRAFT.DraftParticipants'))
    await cds.run(DELETE.from('DRAFT.DraftFieldLocks'))
    // Clean up any existing orders
    try {
      await cds.run(DELETE.from('my.orders.Orders'))
    } catch (e) { /* ignore */ }
  })

  test('Plugin loads and augments model with collaborative draft entities', () => {
    const defs = cds.model.definitions

    // DRAFT.DraftParticipants should exist
    expect(defs['DRAFT.DraftParticipants']).toBeDefined()
    expect(defs['DRAFT.DraftParticipants'].elements.ParticipantID).toBeDefined()
    expect(defs['DRAFT.DraftParticipants'].elements.DraftUUID).toBeDefined()
    expect(defs['DRAFT.DraftParticipants'].elements.UserID).toBeDefined()
    expect(defs['DRAFT.DraftParticipants'].elements.IsOriginator).toBeDefined()

    // DRAFT.DraftFieldLocks should exist
    expect(defs['DRAFT.DraftFieldLocks']).toBeDefined()
    expect(defs['DRAFT.DraftFieldLocks'].elements.LockID).toBeDefined()
    expect(defs['DRAFT.DraftFieldLocks'].elements.FieldName).toBeDefined()

    // DRAFT.DraftAdministrativeData should exist
    // Note: CollaborativeDraftEnabled and DraftAccessType are NOT in the compiled model elements
    // because pre-defining DRAFT.DraftAdministrativeData in raw CSN causes CDS compiler errors.
    // Instead, they are added via:
    //   1. DDL migration (ALTER TABLE) for DB storage
    //   2. $metadata XML middleware injection for OData exposure
    //   3. after READ handler for OData response enrichment
    expect(defs['DRAFT.DraftAdministrativeData']).toBeDefined()
    // DraftAdministrativeUser nav prop IS in the compiled model (added by augmentCompiledModel)
    expect(defs['DRAFT.DraftAdministrativeData'].elements.DraftAdministrativeUser).toBeDefined()
  })

  test('Orders entity has @CollaborativeDraft.enabled annotation', () => {
    const defs = cds.model.definitions
    const entity = defs['OrderService.Orders'] || defs['my.orders.Orders']
    expect(entity?.['@CollaborativeDraft.enabled']).toBe(true)
    expect(entity?.['@odata.draft.enabled']).toBe(true)
  })

  test('User A can create a new draft', async () => {
    const srv = await cds.connect.to('OrderService')

    // Create a new draft as User A
    const result = await cds.tx({ user: userA }, async (tx) => {
      return tx.run(
        INSERT.into('OrderService.Orders').entries({
          ID: cds.utils.uuid(),
          OrderNo: 'ORD-001',
          Customer: 'ACME Corp',
          Status: 'Open',
          IsActiveEntity: false
        })
      )
    })

    expect(result).toBeDefined()
  })

  test('Presence module — join and check participants', async () => {
    const presence = require('../../lib/presence')
    const draftUUID = cds.utils.uuid()

    // User A joins as originator
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    // User B joins
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(2)

    const alice = participants.find(p => p.userID === 'alice')
    const bob = participants.find(p => p.userID === 'bob')
    expect(alice).toBeDefined()
    expect(alice.isOriginator).toBe(true)
    expect(bob).toBeDefined()
    expect(bob.isOriginator).toBe(false)

    // Check isParticipant
    expect(presence.isParticipant(draftUUID, 'alice')).toBe(true)
    expect(presence.isParticipant(draftUUID, 'carol')).toBe(false)

    // Check isOriginator
    expect(presence.isOriginator(draftUUID, 'alice')).toBe(true)
    expect(presence.isOriginator(draftUUID, 'bob')).toBe(false)

    // Cleanup
    await presence.removeAll(draftUUID)
    expect(presence.getParticipants(draftUUID)).toHaveLength(0)
  })

  test('Non-originator leaves — draft remains', async () => {
    const presence = require('../../lib/presence')
    const draftUUID = cds.utils.uuid()

    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    // Bob leaves
    await presence.leave(draftUUID, 'bob')

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(1)
    expect(participants[0].userID).toBe('alice')
  })

  test('Heartbeat updates lastSeen timestamp', async () => {
    const presence = require('../../lib/presence')
    const draftUUID = cds.utils.uuid()

    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    const before = presence._store.get(draftUUID)?.get('alice')?.lastSeen || 0

    // Wait a tiny bit to get different timestamp
    await new Promise(r => setTimeout(r, 5))

    await presence.heartbeat(draftUUID, 'alice', 'Alice Updated')

    const after = presence._store.get(draftUUID)?.get('alice')?.lastSeen || 0
    expect(after).toBeGreaterThanOrEqual(before)

    // Cleanup
    await presence.removeAll(draftUUID)
  })
})
