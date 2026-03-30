/**
 * Ambient declarations for CAP's runtime-injected global query builders.
 * These are injected by @sap/cds at runtime and are not importable —
 * they exist as Node.js globals when CAP bootstraps.
 */

/* eslint-disable no-var */
declare var SELECT: any
declare var INSERT: any
declare var UPDATE: any
declare var DELETE: any

/**
 * @sap/cds does not ship comprehensive TypeScript declarations.
 * We declare it as `any` here to allow untyped usage throughout the plugin.
 */
declare module '@sap/cds' {
  const cds: any
  export = cds
}
