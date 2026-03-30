# cap-collaborative-draft

> **Active Development Notice**
> This plugin is under active development. Public APIs, annotation names, OData contracts, and configuration keys may change without prior notice until a stable 1.0 release is published. Pin to an exact version in production and review the changelog before upgrading.

A `cds-plugin` that enables **SAP Fiori Elements Collaborative Draft** on CAP Node.js backends — a feature normally exclusive to ABAP RAP.

Collaborative Draft lets multiple authenticated users co-edit the same draft instance simultaneously, with live presence awareness, field-level locking, and automatic participant management. This plugin brings that capability to any CAP Node.js service by implementing the required OData contract, database schema, and handler logic — without requiring any ABAP infrastructure.

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Phase 0 — Raw CSN Augmentation](#phase-0--raw-csn-augmentation)
  - [Phase 1 — Compiled Model Augmentation](#phase-1--compiled-model-augmentation)
  - [Phase 2 — $metadata Middleware](#phase-2--metadata-middleware)
  - [Phase 3 — Handler Registration](#phase-3--handler-registration)
  - [Presence Tracking](#presence-tracking)
  - [Field-Level Locking](#field-level-locking)
  - [User Directory](#user-directory)
  - [WebSocket Integration](#websocket-integration)
- [OData Contract](#odata-contract)
  - [DraftAdministrativeData Extensions](#draftadministrativedata-extensions)
  - [DraftAdministrativeUser Navigation](#draftadministrativeuser-navigation)
  - [ColDraftShare Bound Action](#coldraftshare-bound-action)
  - [ColDraftUsers Entity](#coldraftusers-entity)
- [Configuration](#configuration)
- [Fiori Elements Integration](#fiori-elements-integration)
  - [Required Annotations](#required-annotations)
  - [Invite Dialog and User Search](#invite-dialog-and-user-search)
  - [Participant Avatars](#participant-avatars)
  - [WebSocket Real-Time Updates](#websocket-real-time-updates)
- [Multi-Instance Deployment](#multi-instance-deployment)
- [Limitations and Known Gaps](#limitations-and-known-gaps)
- [Compatibility](#compatibility)
- [Development and Testing](#development-and-testing)
- [License](#license)

---

## Overview

SAP Fiori Elements Collaborative Draft is the standard mechanism for multi-user concurrent editing of draft objects in SAP enterprise applications. In ABAP RAP, it is implemented through a combination of:

- **RAP collaborative draft toggle** in the BOPF framework
- **OData annotations** (`@Common.DraftRoot.ShareAction`, `CollaborativeDraftEnabled`, `DraftAccessType`)
- **ABAP Push Channel (WebSockets)** for real-time presence relay
- **OData actions** for participant join, field lock, and share operations

This plugin replicates the full OData contract on CAP Node.js, allowing Fiori Elements clients to activate their collaborative draft UI against a CAP backend. The plugin is additive — existing entities without `@CollaborativeDraft.enabled` are completely unaffected.

### Live Demo

https://github.com/user-attachments/assets/cap-collaborative-draft.mp4

<video src="docs/cap-collaborative-draft.mp4" controls width="100%"></video>

---

## Installation

```bash
npm add cap-collaborative-draft
```

The plugin is auto-discovered by CAP via the `cds-plugin.js` convention. No additional wiring, service registration, or `cds.serve()` call is required.

**Peer dependency:** `@sap/cds >= 8.0`

**Optional peer dependency:** `@cap-js-community/websocket` — if present, the plugin registers a WebSocket relay service for real-time presence and lock broadcasts. If absent, the plugin operates in pull-only mode.

---

## Quick Start

### 1. Annotate your service entity

Add both `@odata.draft.enabled` and `@CollaborativeDraft.enabled: true` to the service-level entity projection. Both annotations must be on the **service** entity (not the underlying DB entity):

```cds
// srv/service.cds
using { my.orders } from '../db/schema';

service OrderService {

  @odata.draft.enabled
  @CollaborativeDraft.enabled: true
  entity Orders as projection on my.orders.Orders {
    *, Items
  }
}
```

> **Annotation placement:** Both annotations belong on the service-layer entity, not the database entity. Placing `@odata.draft.enabled` on a database entity is non-standard in CDS and may produce unexpected draft table generation. `@CollaborativeDraft.enabled` annotations on database entities are silently ignored by this plugin.

### 2. Start your CAP application

```bash
cds watch
```

The plugin logs two info-level messages at startup:

```log
[collab-draft] - cap-collaborative-draft plugin loaded
[collab-draft] - Collaborative draft enabled for OrderService [ Orders ]
```

### 3. Verify the OData contract

```bash
curl http://localhost:4004/odata/v4/order/$metadata | grep -E 'ColDraftShare|CollaborativeDraftEnabled|DraftAdministrativeUser'
```

You should see all three terms in the output, confirming the plugin has correctly augmented the metadata.

---

## How It Works

The plugin hooks into four distinct stages of the CAP bootstrap lifecycle.

### Phase 0 — Raw CSN Augmentation

**Hook:** `cds.on('loaded')`

At raw CSN stage (before `cds.compile.for.nodejs`), the plugin:

1. Scans `csn.definitions` for all service entities that carry both `@CollaborativeDraft.enabled: true` and `@odata.draft.enabled`. Only entities with a `query` or `projection` property are considered (i.e., service projections — not bare database entities).
2. Creates `DRAFT.DraftParticipants` and `DRAFT.DraftFieldLocks` entity definitions in the raw CSN if they do not already exist, causing CDS to deploy the corresponding database tables alongside the standard draft tables.
3. Adds `@Common.DraftRoot.ShareAction` annotation to each qualifying entity, naming the action `<EntityShortName>_ColDraftShare`.

### Phase 1 — Compiled Model Augmentation

**Hook:** `cds.on('served')` (compiled model available)

After CDS compiles the model for Node.js, the plugin:

1. Adds `CollaborativeDraftEnabled: Boolean` and `DraftAccessType: String(1)` to the `DRAFT.DraftAdministrativeData` element map (and all service-projected copies of it). These fields are readable via OData even though they are backed by columns added via DDL migration rather than a CDS `extend`.
2. Creates `DRAFT.DraftAdministrativeUser` as a virtual entity (no persistence) and adds it as a contained navigation property on `DraftAdministrativeData`. Fiori Elements reads this navigation property to display the participant avatar group.
3. Creates `<ServiceNs>.ColDraftUsers` as a virtual entity for each service. This entity backs the user search value help in the invite dialog.
4. Registers the `<EntityShortName>_ColDraftShare` bound action definition on each collaborative entity, including its `Users` (`Collection(ColDraftShareUser)`) parameter and `ShareAll`/`IsDeltaUpdate` flags.
5. Creates the `<ServiceNs>.ColDraftShareUser` complex type used as the action parameter.

### Phase 2 — $metadata Middleware

**Hook:** Express middleware registered via `cds.on('bootstrap')`

CAP generates `$metadata` XML from the compiled model. For certain aspects of the collaborative draft contract, runtime XML injection is more reliable than compiled model manipulation. The middleware intercepts every `$metadata` response and idempotently patches:

| Injection | Condition |
| --- | --- |
| `CollaborativeDraftEnabled` + `DraftAccessType` properties | Added to `DraftAdministrativeData` EntityType if absent |
| `DraftAdministrativeUser` NavigationProperty | Added to `DraftAdministrativeData` EntityType if absent |
| `DraftAdministrativeUser` EntityType | Injected as fallback if not produced by model compiler |
| `NavigationPropertyBinding` for `DraftAdministrativeData/DraftAdministrativeUser` | Added to all relevant EntitySets |
| `ColDraftShareUser` ComplexType | Injected if absent |
| `ColDraftUsers` EntityType and EntitySet | Injected if absent |
| `@Common.ValueList` on `ColDraftShareUser/UserID` | Points to `ColDraftUsers` for the invite dialog user search |
| `@Common.WebSocketBaseURL` / `@Common.WebSocketChannel` | Injected on the EntityContainer when WebSocket is available |
| `@Common.SideEffects` for presence and draft change events | Injected on the collaborative entity's Annotations block |

### Phase 3 — Handler Registration

**Hook:** `cds.on('served')`, registered via `srv.prepend()`

Handlers are prepended before CAP's built-in lean-draft handlers so they execute first. Only services that contain at least one collaborative draft entity receive these handlers.

| Event | Behavior |
| --- | --- |
| `EDIT` | If a draft already exists for the entity, the current user joins it (added to the presence store) rather than receiving HTTP 423 "locked by another user". Sets `InProcessByUser = ''` to indicate shared ownership. |
| `after EDIT` | Registers the user as originator if they created the draft, or as participant if they joined. Persists to `DRAFT.DraftParticipants` and runs the DB migration for `CollaborativeDraftEnabled`/`DraftAccessType` columns if not already present. |
| `before PATCH` | Acquires field-level locks in `DRAFT.DraftFieldLocks`. Responds HTTP 409 if another participant holds a non-expired lock on any of the patched fields. Sets `InProcessByUser` to the current user to satisfy CAP's internal ownership check. |
| `before draftPrepare` | Validates cross-participant field consistency. Logs conflicts; does not block activation. |
| `before draftActivate` | Sets `InProcessByUser` to the current user so any participant can activate (not just the originator). |
| `after draftActivate` | Cleans up all presence records and field locks for the draft UUID. |
| `before CANCEL` | If the requesting user is the originator, the cancel proceeds for all participants. If a non-originator, removes only that participant from the presence store and returns HTTP 409 to keep the draft alive for others. |
| `after READ DraftAdministrativeData` | Populates `CollaborativeDraftEnabled` (boolean) and `DraftAccessType` by inspecting the presence store and the DB record. Ensures the response always carries proper JSON booleans (not SQLite integers). |
| `READ DraftAdministrativeUser` | Resolves participants from the in-memory presence store (with DB fallback) and maps them to the `{DraftUUID, UserID, UserDescription, UserEditingState}` shape expected by Fiori Elements. |
| `READ ColDraftUsers` | Serves the user directory for the invite dialog value help. See [User Directory](#user-directory). |
| `<EntityName>_ColDraftShare` | Handles the bound share action. Registers the specified users as participants, sets `DraftAccessType = 'S'` and `CollaborativeDraftEnabled = 1` in the DB, and broadcasts a `CollaborativePresenceChanged` WebSocket event if WebSocket is available. |

### Presence Tracking

Implemented in `lib/presence.ts`.

**In-memory store:** `Map<DraftUUID, Map<UserID, { displayName, lastSeen, isOriginator }>>` — O(1) lookups per draft.

**DB persistence:** `DRAFT.DraftParticipants` — written on every join/heartbeat/leave so that presence survives server restarts. Loaded back into memory on startup via `loadFromDB()`.

**Eviction:** A background `setInterval` (default: every 30 seconds) scans all entries and removes any participant whose `lastSeen` exceeds the configured TTL (default: 5 minutes). The timer is `.unref()`-ed so it does not block process exit. Evicted entries are also deleted from the DB.

| Function | Description |
| --- | --- |
| `join(draftUUID, userID, opts)` | Adds or refreshes a participant. Preserves `isOriginator` on rejoin. |
| `heartbeat(draftUUID, userID)` | Updates `lastSeen` without changing other fields. |
| `leave(draftUUID, userID)` | Explicit removal (non-originator cancel, LEAVE WebSocket message). |
| `removeAll(draftUUID)` | Removes all participants (draftActivate, originator cancel). |
| `getParticipants(draftUUID)` | Returns the current participant list as `ParticipantRecord[]`. |
| `isOriginator(draftUUID, userID)` | Returns whether the user created the draft. |

### Field-Level Locking

Implemented in `lib/field-locks.ts`.

Locks are stored in `DRAFT.DraftFieldLocks` with a composite key of `(DraftUUID, EntityKey, FieldName)`. Each lock record carries a `LockedAt` timestamp; locks older than the configured TTL (default: 120 seconds) are treated as expired and do not block new acquisitions.

The locking granularity corresponds to individual OData property names (field names as they appear in the PATCH request body). An entity key is serialized as a stable JSON string to handle composite keys.

| Function | Description |
| --- | --- |
| `acquireLocks(draftUUID, userID, entityKey, fields)` | Attempts to acquire all specified locks atomically. Returns a result indicating which locks were acquired and which were blocked by another participant. |
| `releaseLocks(draftUUID, userID)` | Releases all locks held by a user for a given draft. Called on participant leave and cancel. |
| `releaseAllLocks(draftUUID)` | Releases all locks for a draft. Called on activation and originator cancel. |
| `getActiveLocks(draftUUID)` | Returns non-expired locks. Used by Fiori Elements lock echo response. |

### User Directory

The `ColDraftUsers` OData entity set backs the **user search value help** in the Fiori Elements invite dialog. It supports two operating modes:

#### Mode 1 — Entity-backed (recommended for production)

Point the plugin at any CDS entity or projection — a real database table is used, making it suitable for thousands of users. The `READ ColDraftUsers` handler delegates to `cds.run(SELECT …)` and pushes `$filter`/`$search` down to the database.

```json
// package.json → "cds" block, or .cdsrc.json
{
  "collab": {
    "users": {
      "entity": "OrderService.Users",
      "userIdField": "email",
      "userDescriptionField": "displayName"
    }
  }
}
```

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `entity` | yes | — | Fully qualified CDS entity name (service projection or direct DB entity) |
| `userIdField` | no | `"UserID"` | Source field mapped to `UserID` in the OData response |
| `userDescriptionField` | no | `"UserDescription"` | Source field mapped to `UserDescription` in the OData response |

The entity only needs to be readable by the CAP runtime — it does not have to be exposed as its own OData entity set. A projection without `@odata.draft.enabled` on a dedicated service (or the same application service) works well:

```cds
// srv/service.cds
extend service OrderService {
  // Read-only user directory, not directly exposed via FE but reachable by the plugin
  @readonly entity Users as projection on my.Users {
    key email       as UserID,
        displayName as UserDescription
  };
}
```

When `userIdField`/`userDescriptionField` match the entity's actual column names, the `AS` aliases are redundant but harmless.

#### Mode 2 — Static map (development / small environments)

`cds.env.collab.users` as a plain object map, or the standard CAP mock auth user list:

**Data sources (in priority order):**

1. `cds.env.collab.users` — a plain object map of `{ "<userID>": { "displayName": "…" } }`.
2. `cds.env.requires.auth.users` — the standard CAP mock auth user map (populated automatically in development from `.cdsrc.json`).
3. Empty list — if neither source is configured.

```json
{
  "collab": {
    "users": {
      "john.doe@example.com": { "displayName": "John Doe" },
      "jane.smith@example.com": { "displayName": "Jane Smith" }
    }
  }
}
```

In static mode, `$filter` and `$search` are applied in memory after loading the full map.

### WebSocket Integration

When `@cap-js-community/websocket` is installed and active, the plugin registers a `CollabDraftWebSocketService` on the `/ws/collab-draft` path. The WebSocket service relays the following message types (PCP-style JSON envelope):

| Message Type | Direction | Description |
| --- | --- | --- |
| `JOIN` | Client → Server | User opens a draft. Server responds with `JOINECHO` carrying current participant list. |
| `JOINECHO` | Server → Client | Broadcasts participant list to all connected clients for the draft. |
| `LEAVE` | Client → Server | User closes a draft or navigates away. Server broadcasts updated presence. |
| `LOCK` | Client → Server | User focuses a field. Server acquires DB lock and broadcasts `LOCKECHO`. |
| `LOCKECHO` | Server → Client | Broadcasts lock state to all clients. FE renders field lock indicators. |
| `UNLOCK` | Client → Server | User blurs a field. Server releases the lock. |
| `CHANGE` | Server → Client | Broadcasts a field value change to all other participants. |
| `ACTIVATE` | Server → Client | Notifies all clients that the draft has been activated. |
| `DISCARD` | Server → Client | Notifies all clients that the draft has been discarded. |

Without WebSocket, the plugin operates in **pull-only mode**: presence and lock state are correct and available via standard OData reads, but updates from other participants only appear after a client-triggered re-read (governed by `@Common.SideEffects`).

---

## OData Contract

### DraftAdministrativeData Extensions

Two properties are added to `DraftAdministrativeData` (and all service-projected copies):

| Property | OData Type | Description |
| --- | --- | --- |
| `CollaborativeDraftEnabled` | `Edm.Boolean` | `true` when the draft has active participants. Always returns a proper JSON boolean — never a SQLite integer. |
| `DraftAccessType` | `Edm.String` (MaxLength=1) | `"S"` for shared (collaborative) drafts. `null` for standard exclusive drafts. |

### DraftAdministrativeUser Navigation

A contained navigation property `DraftAdministrativeUser` is added to `DraftAdministrativeData`, pointing to a collection of:

| Property | Type | Description |
| --- | --- | --- |
| `DraftUUID` | `Edm.Guid` (key) | UUID of the draft |
| `UserID` | `Edm.String` (key) | Authenticated user ID |
| `UserDescription` | `Edm.String` | Display name |
| `UserEditingState` | `Edm.String` | `"N"` (no changes) or `"P"` (pending changes) |

Fiori Elements reads this navigation property (with `UserID ne '<currentUser>'` filter) to display the participant avatar group and to populate the discard confirmation dialog.

### ColDraftShare Bound Action

Added as a bound action on each collaborative entity:

```xml
<Action Name="Orders_ColDraftShare" IsBound="true">
  <Parameter Name="bindingParameter" Type="Collection(OrderService.Orders)"/>
  <Parameter Name="Users" Type="Collection(OrderService.ColDraftShareUser)" Nullable="true"/>
  <Parameter Name="ShareAll" Type="Edm.Boolean" Nullable="true"/>
  <Parameter Name="IsDeltaUpdate" Type="Edm.Boolean" Nullable="true"/>
</Action>
```

Referenced via `@Common.DraftRoot.ShareAction = 'OrderService.Orders_ColDraftShare'`. Fiori Elements calls this action from the invite dialog when the user clicks "Invite".

The action accepts:

- `ShareAll: true` with an empty `Users` array — registers the calling user as a participant (self-join, called by the Fiori Elements client on draft open).
- A non-empty `Users` array — invites specific users, setting them as participants in `DRAFT.DraftParticipants`.

### ColDraftUsers Entity

A virtual (non-persisted) entity set used exclusively for the value help in the invite dialog:

| Property | Type |
| --- | --- |
| `UserID` | `Edm.String` (key, MaxLength=256) |
| `UserDescription` | `Edm.String` (MaxLength=256) |

The corresponding `@Common.ValueList` annotation is injected on `ColDraftShareUser/UserID` during `$metadata` patching, pointing the Fiori Elements `ValueHelpDelegate` to this entity set.

---

## Configuration

All settings are namespaced under `cds.collab` and can be set in `package.json` (`"cds"` key) or `.cdsrc.json`:

```json
{
  "cds": {
    "collab": {
      "presenceTtlMs": 300000,
      "lockTtlMs": 120000,
      "cleanupIntervalMs": 30000,
      "users": {
        "john.doe@example.com": { "displayName": "John Doe" }
      }
    }
  }
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `presenceTtlMs` | `number` | `300000` (5 min) | Milliseconds of inactivity before a participant is automatically evicted from the presence store. |
| `lockTtlMs` | `number` | `120000` (2 min) | Milliseconds after a PATCH before a field lock is considered stale and non-blocking. |
| `cleanupIntervalMs` | `number` | `30000` (30 s) | How frequently the background cleanup timer scans for stale presence entries. |
| `users` | `object` | `undefined` | Static user directory for the invite value help. Each key is a `UserID`; values may carry `displayName`. Falls back to `cds.env.requires.auth.users` if not set. |

---

## Fiori Elements Integration

### Required Annotations

The plugin automatically adds all required annotations to `$metadata`. No manual annotation in `service.cds` is needed beyond the entity-level `@CollaborativeDraft.enabled: true`. Specifically, the plugin injects:

- `@Common.DraftRoot.ShareAction` — triggers the invite button in the Object Page header
- `@Common.WebSocketBaseURL` and `@Common.WebSocketChannel` — enable WebSocket connectivity in FE (when WebSocket is available)
- `@Common.SideEffects` for `CollaborativePresenceChanged` and `CollaborativeDraftChanged` events — instructs FE when to re-read the entity binding

### Invite Dialog and User Search

The Fiori Elements invite dialog (`CollaborationDraft` building block) renders a "Search User" input field backed by a value help. The value help reads from the `ColDraftUsers` entity set served by this plugin.

In development, users from `cds.env.requires.auth.users` are automatically available. In production, configure an entity-backed user directory via `cds.env.collab.users.entity` (see [User Directory](#user-directory)) so that search queries are pushed to the database rather than loaded in memory.

### Participant Avatars

Participant avatars in the Object Page header are rendered by the `CollaborationDraft` building block (a custom Fiori Elements building block, available as a code snippet in `ui5-snippets/CollaborationDraft.tsx`). The building block reads from `DraftAdministrativeData/DraftAdministrativeUser`. This building block is **not automatically injected** by the plugin — it must be added to the Object Page by the consuming application, typically via a custom Object Page header section in `manifest.json` or a controller extension.

### WebSocket Real-Time Updates

When `@cap-js-community/websocket` is installed, the Fiori Elements client connects to `/ws/collab-draft` immediately on draft open. The WebSocket URL parameters include the draft UUID and, optionally, user identity (`userID`, `userName`) when the FLP sandbox is started with `?useFLPUser=true`.

Without WebSocket, Fiori Elements falls back gracefully to OData polling triggered by `@Common.SideEffects`. Presence and lock correctness are unaffected — only the real-time latency of updates changes.

---

## Multi-Instance Deployment

The in-memory presence store (`lib/presence.ts`) is **per process**. In a horizontally scaled deployment with multiple CAP instances behind a load balancer:

- **Presence reads via OData** (`DraftAdministrativeData/DraftAdministrativeUser`) are consistent across instances because they are backed by `DRAFT.DraftParticipants` in the shared database. The in-memory store is a write-through cache that improves latency on the same instance.
- **Field lock checks** read from `DRAFT.DraftFieldLocks` in the database, so they are also cross-instance consistent.
- **WebSocket relay** is per-instance. A participant on instance A will not receive WebSocket messages broadcast by instance B. For multi-instance real-time relay, a shared pub/sub channel (e.g., Redis) is required — this is outside the current scope of this plugin.

**Recommendation for multi-instance deployments:** Rely on OData polling (via `@Common.SideEffects`) rather than WebSocket for presence and lock updates. The OData contract is always consistent; only real-time latency is affected.

---

## Limitations and Known Gaps

| Area | Status | Notes |
| --- | --- | --- |
| Single-instance in-memory presence | Partial | Cross-instance consistent via DB; real-time WebSocket relay is per-instance only. |
| WebSocket multi-instance pub/sub | Not implemented | Requires Redis or equivalent adapter. |
| Conflict merge on `draftActivate` | Logging only | Cross-participant field conflicts are detected and logged; no automatic merge or user-facing conflict resolution UI. |
| `UserDescription` in mock users | ID = Description | CAP mock auth users do not carry display names; `UserDescription` equals `UserID` unless `cds.collab.users` is configured. |
| `CollaborationDraft` building block | Not auto-injected | The participant avatar group and invite button require a custom Object Page fragment. See `ui5-snippets/CollaborationDraft.tsx`. |
| `CollaborationDiscardDialog` | Not auto-injected | The "other users are editing" discard confirmation dialog requires a custom controller extension. See `ui5-snippets/CollaborationDiscardDialog.tsx`. |
| PATCH field lock granularity | Property-level | Locks are per property name. Composite nested entity locking (child entities, associations) is not yet implemented. |

---

## Compatibility

| Dependency | Version |
| --- | --- |
| `@sap/cds` | `>= 8.0` |
| Node.js | `>= 18` |
| `@cap-js/sqlite` | `>= 2.0` (development / testing) |
| `@cap-js-community/websocket` | `>= 1.0` (optional, for real-time relay) |
| Fiori Elements (`sap.fe.templates`) | `>= 1.120` (SAPUI5 1.120+) |

> The plugin is tested against `@sap/cds` 8.x and SAPUI5 1.146. Compatibility with earlier versions of either dependency is not guaranteed.

---

## Development and Testing

### Starting the test app

```bash
cd test/app && npx cds watch
```

Open the Fiori Launchpad sandbox at:

```text
http://localhost:4004/orders/webapp/test/flpSandbox.html?useFLPUser=true
```

The `?useFLPUser=true` parameter instructs the WebSocket client to pass the FLP user identity as URL parameters on the WebSocket connection URL.

### Verifying the OData contract

```bash
# Check that all collaborative draft annotations are present
curl http://localhost:4004/odata/v4/order/$metadata \
  | grep -E 'ColDraftShare|CollaborativeDraftEnabled|DraftAdministrativeUser|ColDraftUsers|ShareAction'

# Check DraftAdministrativeData for a specific draft
curl "http://localhost:4004/odata/v4/order/Orders(ID=<uuid>,IsActiveEntity=false)/DraftAdministrativeData" \
  | jq '{CollaborativeDraftEnabled, DraftAccessType}'

# List available users for the invite dialog
curl http://localhost:4004/odata/v4/order/ColDraftUsers | jq '.value[]'

# Check WebSocket connectivity
wscat -c "ws://localhost:4004/ws/collab-draft?draft=<draftUUID>"
```

### Building from source

The plugin is authored in TypeScript and compiled to CommonJS in `dist/`:

```bash
npm run build        # tsc
```

`cds-plugin.js` is a thin shim (`module.exports = require('./dist/cds-plugin')`). CAP discovers it by filename convention.

### Running tests

```bash
npm test             # Jest integration tests
npx playwright test  # E2E browser tests (requires running test app)
```

---

## License

Apache-2.0
