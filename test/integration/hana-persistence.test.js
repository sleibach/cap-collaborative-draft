'use strict'

/**
 * Regression test for the HANA / HDI persistence bug.
 *
 * Background: earlier versions added the collaborative columns
 * (CollaborativeDraftEnabled / DraftAccessType) to the CAP-generated
 * DRAFT_DraftAdministrativeData table via runtime `ALTER TABLE ... ADD COLUMN`.
 * That only works on databases where the runtime user owns the schema (SQLite).
 * On SAP HANA Cloud behind an HDI container it fails with a DDL syntax error and,
 * once corrected, "insufficient privilege" (the runtime user has no DDL rights).
 *
 * The fix moves the collaborative state into a plugin-owned, fully-modeled
 * DRAFT.CollaborativeDraftState table that is created by the regular deployment
 * (cds deploy / HDI deploy run by the privileged deployer) on every database.
 *
 * These tests are intentionally model-/compile-level only: they assert the
 * generated persistence model and DDL, and do not boot a database server.
 */

const cds = require('@sap/cds')
const { augmentModel } = require('../../dist/lib/model-augmenter')

const MODEL = ['test/app/srv', 'test/app/db', 'test/app/app']

describe('HANA / HDI persistence (no runtime DDL)', () => {
  test('augmentModel adds a persisted, plugin-owned DRAFT.CollaborativeDraftState table', async () => {
    const csn = await cds.load(MODEL)
    augmentModel(csn)

    const state = csn.definitions['DRAFT.CollaborativeDraftState']
    expect(state).toBeDefined()
    expect(state.kind).toBe('entity')
    // Must be persisted (not skipped) so the deployer creates the table.
    expect(state['@cds.persistence.skip']).not.toBe(true)
    expect(state.elements.DraftUUID.key).toBe(true)
    expect(state.elements.CollaborativeDraftEnabled.type).toBe('cds.Boolean')
    expect(state.elements.DraftAccessType.type).toBe('cds.String')
  })

  test('raw CSN augmentation does NOT add physical columns to DRAFT_DraftAdministrativeData', async () => {
    const csn = await cds.load(MODEL)
    augmentModel(csn)
    // The compiler-owned draft admin entity must not be pre-defined / extended here.
    expect(csn.definitions['DRAFT.DraftAdministrativeData']).toBeUndefined()
  })

  test('compiled SQL DDL contains the companion table and no collab columns on draft admin data', async () => {
    // Apply the plugin's raw-CSN augmentation, then compile that model to SQL.
    // (Programmatic cds.compile does not auto-load cds-plugins, so we invoke it directly —
    // this mirrors what cds.on('loaded') does at runtime / during `cds build`.)
    const csn = await cds.load(MODEL)
    augmentModel(csn)
    const compiled = await cds.compile(csn).to.sql()
    const ddl = Array.isArray(compiled) ? compiled.join('\n') : String(compiled)

    expect(ddl).toMatch(/CREATE TABLE DRAFT_CollaborativeDraftState/)

    // Isolate the DRAFT_DraftAdministrativeData CREATE TABLE statement and ensure
    // the collaborative columns are NOT physical columns on it.
    const m = ddl.match(/CREATE TABLE DRAFT_DraftAdministrativeData \(([\s\S]*?)\);/)
    expect(m).not.toBeNull()
    expect(m[1]).not.toMatch(/CollaborativeDraftEnabled/)
    expect(m[1]).not.toMatch(/DraftAccessType/)
  })

  test('no runtime ALTER TABLE on DRAFT_DraftAdministrativeData remains in the plugin', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(path.join(__dirname, '../../dist/cds-plugin.js'), 'utf8')
    // Allow the explanatory comment, but assert there is no executable ALTER statement.
    const executableAlter = src
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .some(l => /ALTER TABLE DRAFT_DraftAdministrativeData/.test(l))
    expect(executableAlter).toBe(false)
  })
})
