'use strict'

import cds = require('@sap/cds')

export interface CollabConfig {
  presenceTtlMs?: number
  fieldLockTtlMs?: number
  cleanupIntervalMs?: number
  users?: Record<string, { displayName?: string }> | {
    entity?: string
    userIdField?: string
    userDescriptionField?: string
  }
}

/**
 * Returns the plugin's runtime configuration from cds.env.collab.
 */
export function collabConfig(): CollabConfig {
  return (cds.env as any).collab ?? {}
}
