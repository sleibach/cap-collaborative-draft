#!/usr/bin/env node
/**
 * Wraps a raw HANA HDI service key (read from stdin) into the VCAP_SERVICES
 * structure CAP expects, and writes it to ./default-env.json in the current
 * working directory.
 *
 * Usage (key must be on the macOS clipboard):
 *   cd test/app && pbpaste | node ../../scripts/wrap-hana-binding.mjs
 *
 * default-env.json is gitignored — never commit it.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const raw = readFileSync(0, 'utf8').trim()
if (!raw) {
  console.error('✗ No input on stdin. Copy the service key JSON to your clipboard, then run: pbpaste | node ...')
  process.exit(1)
}

let credentials
try {
  credentials = JSON.parse(raw)
} catch (e) {
  console.error('✗ Clipboard content is not valid JSON:', e.message)
  console.error('  Make sure you copied the entire service key object, starting with { and ending with }.')
  process.exit(1)
}

// If the key was pasted as a full VCAP-style entry, unwrap it down to credentials.
if (credentials.credentials && typeof credentials.credentials === 'object') {
  credentials = credentials.credentials
}

const looksLikeHana = credentials.host || credentials.url || credentials.serviceUrls || credentials.hdi_user
if (!looksLikeHana) {
  console.error('⚠ Warning: this does not look like a HANA service key (no host/url/hdi_user field). Writing anyway.')
}

const out = {
  VCAP_SERVICES: {
    hana: [
      {
        label: 'hana',
        plan: 'hdi-shared',
        tags: ['hana'],
        name: 'collab-draft-db',
        credentials
      }
    ]
  }
}

writeFileSync('default-env.json', JSON.stringify(out, null, 2))
const keys = Object.keys(credentials).join(', ')
console.log('✓ wrote ' + process.cwd() + '/default-env.json')
console.log('  credential fields: ' + keys)
