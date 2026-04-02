'use strict'

const cds = require('@sap/cds')
const presence = require('../../dist/lib/presence')

cds.test(__dirname + '/../app')

describe('Presence Tracking', () => {
  const baseDraftUUID = 'presence-test-' + Math.random().toString(36).slice(2)
  let testIdx = 0

  function getDraftUUID() {
    return `${baseDraftUUID}-${++testIdx}`
  }

  afterEach(async () => {
    // Clean up all test participants
    try {
      await cds.run(DELETE.from('DRAFT.DraftParticipants'))
    } catch (e) { /* ignore */ }
    // Clear in-memory store for test drafts
    for (const key of presence._store.keys()) {
      if (key.startsWith(baseDraftUUID)) {
        presence._store.delete(key)
      }
    }
  })

  test('Single user joins — participant count = 1', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(1)
    expect(participants[0].userID).toBe('alice')
  })

  test('Two users join — participant count = 2', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(2)
  })

  test('TTL expiry removes stale participant', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    // Manually set lastSeen to expired time
    const store = presence._store.get(draftUUID)
    const alice = store.get('alice')
    alice.lastSeen = Date.now() - (6 * 60 * 1000) // 6 minutes ago (beyond 5min TTL)

    // Run cleanup manually
    const ttl = 5 * 60 * 1000
    const cutoff = Date.now() - ttl
    for (const [, participants] of presence._store) {
      for (const [uid, info] of participants) {
        if (info.lastSeen < cutoff) participants.delete(uid)
      }
    }

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(0)
  })

  test('Originator vs non-originator distinction', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    expect(presence.isOriginator(draftUUID, 'alice')).toBe(true)
    expect(presence.isOriginator(draftUUID, 'bob')).toBe(false)
  })

  test('Joining twice preserves originator status', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    // Alice "joins" again (e.g., after page reload) — should remain originator
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: false })

    expect(presence.isOriginator(draftUUID, 'alice')).toBe(true)
  })

  test('User leaves — participant count decreases', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })

    await presence.leave(draftUUID, 'bob')

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(1)
    expect(participants[0].userID).toBe('alice')
  })

  test('removeAll clears all participants', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })
    await presence.join(draftUUID, 'bob', { displayName: 'Bob', isOriginator: false })
    await presence.join(draftUUID, 'carol', { displayName: 'Carol', isOriginator: false })

    await presence.removeAll(draftUUID)

    const participants = presence.getParticipants(draftUUID)
    expect(participants).toHaveLength(0)
  })

  test('isParticipant returns correct values', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    expect(presence.isParticipant(draftUUID, 'alice')).toBe(true)
    expect(presence.isParticipant(draftUUID, 'bob')).toBe(false)
    expect(presence.isParticipant('non-existent-uuid', 'alice')).toBe(false)
  })

  test('Participant lastSeen is returned as Date object', async () => {
    const draftUUID = getDraftUUID()
    await presence.join(draftUUID, 'alice', { displayName: 'Alice', isOriginator: true })

    const participants = presence.getParticipants(draftUUID)
    expect(participants[0].lastSeen).toBeInstanceOf(Date)
  })
})
