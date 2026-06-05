#!/usr/bin/env node
/**
 * HANA / HDI smoke test (plain Node — no jest).
 *
 * Connects to a real HANA HDI container as the runtime user and verifies the
 * collaborative-draft persistence fix end-to-end. Provided in addition to the
 * jest test (test/integration/hana-runtime.test.js) because the jest harness
 * currently hangs in some local environments; this runner does not use jest.
 *
 * Prereqs:  test/app/default-env.json (see scripts/wrap-hana-binding.mjs)
 *           and a deployed schema (npm run hana:deploy).
 * Run:      npm run hana:smoke
 */
process.env.CDS_ENV = 'hana'
const path = require('path')
const cds = require('@sap/cds')
require('../cds-plugin.js')
cds.root = path.resolve(__dirname, '..', 'test/app')
const { SELECT, UPSERT, DELETE } = cds.ql
let pass = 0, fail = 0
const ok = (n) => { console.log('  ✓', n); pass++ }
const no = (n, e) => { console.log('  ✕', n, '->', e); fail++ }
;(async () => {
  const csn = await cds.load('*', { root: cds.root })
  cds.model = cds.compile.for.nodejs(csn)
  const db = await cds.connect.to('db')

  // 1) runtime user is DML-only _RT user
  try { const [{u}] = await db.run(`SELECT CURRENT_USER "u" FROM DUMMY`); /_RT$/.test(u) ? ok('runtime user is _RT ('+u+')') : no('runtime user _RT', u) } catch(e){ no('runtime user', e.message) }

  // 2) companion table queryable
  try { const r = await db.run(SELECT.from('DRAFT.CollaborativeDraftState').limit(1)); Array.isArray(r) ? ok('CollaborativeDraftState queryable') : no('queryable','not array') } catch(e){ no('queryable', e.message) }

  // 3) read/write round-trip
  const id = cds.utils.uuid()
  try {
    await db.run(UPSERT.into('DRAFT.CollaborativeDraftState').entries({ DraftUUID:id, DraftAccessType:'3', CollaborativeDraftEnabled:true }))
    const row = await db.run(SELECT.one.from('DRAFT.CollaborativeDraftState').where({ DraftUUID:id }))
    ;(row && row.DraftAccessType==='3' && row.CollaborativeDraftEnabled===true) ? ok('round-trip UPSERT/SELECT (boolean='+row.CollaborativeDraftEnabled+')') : no('round-trip', JSON.stringify(row))
    await db.run(DELETE.from('DRAFT.CollaborativeDraftState').where({ DraftUUID:id }))
    const gone = await db.run(SELECT.one.from('DRAFT.CollaborativeDraftState').where({ DraftUUID:id }))
    gone ? no('cleanup','row remained') : ok('DELETE cleanup')
  } catch(e){ no('round-trip', e.message); try{ await db.run(DELETE.from('DRAFT.CollaborativeDraftState').where({DraftUUID:id})) }catch{} }

  // 4) negative control: runtime ALTER TABLE must be rejected
  try {
    await db.run(`ALTER TABLE DRAFT_DraftAdministrativeData ADD (X_COLLAB_PROBE NVARCHAR(1))`)
    no('ALTER rejected', 'UNEXPECTEDLY SUCCEEDED — runtime user has DDL?!')
  } catch(e){ ok('runtime ALTER TABLE rejected ('+String(e.message).slice(0,60)+'…)') }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  await (cds.shutdown ? cds.shutdown() : Promise.resolve())
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
