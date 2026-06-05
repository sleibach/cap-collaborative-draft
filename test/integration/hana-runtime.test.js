'use strict'

/**
 * HANA / HDI runtime integration test.
 *
 * Verifies the fix for the bug where collaborative state was added to the
 * CAP-generated DRAFT_DraftAdministrativeData table via runtime `ALTER TABLE`,
 * which fails on SAP HANA Cloud / HDI (invalid syntax + the DML-only runtime
 * user has no DDL privileges).
 *
 * This test connects to a *real* HANA HDI container as the runtime user and:
 *   1. confirms the plugin's DRAFT.CollaborativeDraftState table was created at
 *      deploy time (by the privileged deployer) and is reachable,
 *   2. performs the collaborative read/write round-trip the runtime does,
 *   3. (negative control) proves the runtime user CANNOT run DDL — i.e. the old
 *      ALTER TABLE approach was fundamentally impossible on HDI, which is why
 *      the state had to be modeled as its own table.
 *
 * ── How to run ────────────────────────────────────────────────────────────
 *   1. Provide an HDI service key:  see scripts/wrap-hana-binding.mjs
 *      (writes test/app/default-env.json — gitignored).
 *   2. Deploy the schema once:      npm run hana:deploy
 *   3. Run this test:               npm run test:hana
 *
 * The suite auto-skips when test/app/default-env.json is absent, so the normal
 * `npm test` run (and CI without HANA credentials) is unaffected.
 */

const fs = require('fs')
const path = require('path')

const APP_DIR = path.resolve(__dirname, '../app')
const BINDING = path.join(APP_DIR, 'default-env.json')

// Opt-in only: requires HANA_TEST=1 AND a local HDI binding. This keeps the
// default `npm test` (and CI without credentials) on SQLite and prevents the
// `hana` profile from leaking into sibling test files. Use `npm run test:hana`.
const HANA_ENABLED = !!process.env.HANA_TEST && fs.existsSync(BINDING)
if (HANA_ENABLED) {
  process.env.CDS_ENV = process.env.CDS_ENV || 'hana'
  // CAP resolves the active profile, package.json `cds` config and default-env.json
  // relative to process.cwd(). jest runs from the plugin root, so without this the
  // `[hana]` profile + binding under test/app are not picked up and cds falls back to
  // the default SQLite db. Switch cwd to the app before @sap/cds reads its env.
  process.chdir(APP_DIR)
}

const cds = require('@sap/cds')
const { SELECT, UPSERT, DELETE } = cds.ql

const describeHana = HANA_ENABLED ? describe : describe.skip
if (!HANA_ENABLED) {
  // eslint-disable-next-line no-console
  console.warn('[hana-runtime] skipped — set HANA_TEST=1 and provide test/app/default-env.json (see test header / npm run test:hana).')
}

describeHana('HANA / HDI runtime (collaborative state as a modeled table)', () => {
  let db
  const created = []

  beforeAll(async () => {
    require('../../cds-plugin.js') // register plugin hooks on this cds instance
    cds.root = APP_DIR
    const csn = await cds.load('*', { root: APP_DIR }) // fires the plugin's loaded hook → augmentation
    cds.model = cds.compile.for.nodejs(csn)
    db = await cds.connect.to('db')
  }, 60000)

  afterAll(async () => {
    if (db && created.length) {
      try { await db.run(DELETE.from('DRAFT.CollaborativeDraftState').where({ DraftUUID: created })) } catch { /* ignore */ }
    }
    if (cds.shutdown) await cds.shutdown()
  })

  test('connects as the DML-only HDI runtime user (not the schema owner)', async () => {
    const [{ u }] = await db.run(`SELECT CURRENT_USER "u" FROM DUMMY`)
    // HDI runtime users end in _RT; the deploy/object-owner user does not.
    expect(u).toMatch(/_RT$/)
  })

  test('plugin table DRAFT.CollaborativeDraftState exists and is queryable', async () => {
    // Resolves through the modeled entity → real HDI table. Throws if missing.
    const rows = await db.run(SELECT.from('DRAFT.CollaborativeDraftState').limit(1))
    expect(Array.isArray(rows)).toBe(true)
  })

  test('collaborative read/write round-trip works for the runtime user (the operation the bug broke)', async () => {
    const DraftUUID = cds.utils.uuid()
    created.push(DraftUUID)

    await db.run(UPSERT.into('DRAFT.CollaborativeDraftState').entries({
      DraftUUID, DraftAccessType: '3', CollaborativeDraftEnabled: true
    }))

    const row = await db.run(SELECT.one.from('DRAFT.CollaborativeDraftState').where({ DraftUUID }))
    expect(row).toBeTruthy()
    expect(row.DraftAccessType).toBe('3')
    expect(row.CollaborativeDraftEnabled).toBe(true) // proper boolean, not 0/1

    await db.run(DELETE.from('DRAFT.CollaborativeDraftState').where({ DraftUUID }))
    const gone = await db.run(SELECT.one.from('DRAFT.CollaborativeDraftState').where({ DraftUUID }))
    expect(gone).toBeFalsy()
  })

  test('negative control: runtime user CANNOT ALTER TABLE — proving the old approach was impossible on HDI', async () => {
    // The previous implementation ran exactly this kind of statement at startup.
    // On HDI it must be rejected (insufficient privilege / not allowed on managed objects).
    await expect(
      db.run(`ALTER TABLE DRAFT_DraftAdministrativeData ADD (X_COLLAB_PROBE NVARCHAR(1))`)
    ).rejects.toThrow()
  })
})
