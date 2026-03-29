# cap-collaborative-draft

A `cds-plugin` that enables **SAP Fiori Elements Collaborative Draft** on CAP Node.js backends.

SAP Fiori Elements Collaborative Draft lets multiple users co-edit the same draft instance simultaneously, with presence awareness, field-level locking, and automatic merge on activation. This plugin brings that capability to CAP Node.js — without requiring an ABAP RAP backend.

---

## Installation

```bash
npm add cap-collaborative-draft
```

The plugin is auto-discovered by CAP via the `cds-plugin.js` convention — no additional wiring needed.

---

## Usage

Annotate your entity with `@CollaborativeDraft.enabled: true` alongside the standard `@odata.draft.enabled`:

```cds
using { managed } from '@sap/cds/common';

@CollaborativeDraft.enabled: true
@odata.draft.enabled
entity Orders : managed {
  key ID       : UUID;
  OrderNo      : String(20) @mandatory;
  Customer     : String(100);
  Status       : String(20) default 'Open';
  NetAmount    : Decimal(15,2);
  Currency     : String(3) default 'EUR';
  Items        : Composition of many OrderItems on Items.Order = $self;
}
```

That is the only change needed in your model. The plugin automatically:

- Adds `CollaborativeDraftEnabled` to `DraftAdministrativeData` (both DB and OData `$metadata`)
- Creates `DRAFT.DraftParticipants` and `DRAFT.DraftFieldLocks` tables
- Adds `@Common.DraftRoot.ShareAction` annotation to signal collaborative draft to Fiori Elements
- Overrides draft handlers to allow join, field locking, and clean activation

---

## How It Works

### Phase 0 — CSN Augmentation (`cds.on('loaded')`)

When CAP loads the model (raw CSN stage), the plugin:

1. Scans for entities with `@CollaborativeDraft.enabled: true` and `@odata.draft.enabled: true`
2. Pre-defines `DRAFT.DraftAdministrativeData` in the raw CSN with `CollaborativeDraftEnabled: Boolean` added to the standard fields. Because the cds-compiler checks for an existing `DRAFT.DraftAdministrativeData` definition before generating its own, our definition (including the extra field) is used for both DB schema DDL and OData EDMX generation.
3. Creates `DRAFT.DraftParticipants` and `DRAFT.DraftFieldLocks` entities in the raw CSN for DB deployment.
4. Adds `@Common.DraftRoot.ShareAction` annotation to each collaborative entity.

### Phase 1 — Handler Registration (`cds.on('served')`)

Collaborative draft handlers are registered via `srv.prepend()` — before CAP's built-in lean-draft handlers — on all `ApplicationService` instances that have draft-enabled entities:

- **EDIT (join):** If a draft already exists for the target entity, the current user joins it (added to the presence store) instead of receiving a "draft locked" error. `InProcessByUser` is set to `''` (shared ownership).
- **after EDIT:** Registers the creating user as originator in the presence store and persists to `DRAFT.DraftParticipants`.
- **before PATCH:** Acquires field-level locks in `DRAFT.DraftFieldLocks`. Rejects with HTTP 409 if another participant holds a lock on the same field. Updates `InProcessByUser` to the current user so CAP's internal PATCH check passes.
- **before draftPrepare:** Validates cross-participant consistency (logs conflicts, does not block).
- **before draftActivate:** Sets `InProcessByUser` to current user so any participant can activate.
- **after draftActivate:** Cleans up presence and field-lock records.
- **before CANCEL:** Originator cancels for all; non-originator removes only themselves and returns HTTP 409 (keeping the draft alive for others).
- **after READ DraftAdministrativeData:** Sets `CollaborativeDraftEnabled` based on whether participants are in the presence store.

### Presence Tracking (`lib/presence.js`)

In-memory `Map<DraftUUID, Map<UserID, {displayName, lastSeen, isOriginator}>>` backed by `DRAFT.DraftParticipants` in the database.

- Cleanup timer runs every 30 seconds, evicting participants whose `lastSeen` exceeds the TTL (default: 5 minutes).
- On startup, participants are loaded from DB to survive server restarts.

### Field-Level Locking (`lib/field-locks.js`)

Locks are stored in `DRAFT.DraftFieldLocks`. Each lock has a TTL of 120 seconds — stale locks are automatically filtered in lock checks.

- `acquireLock` / `acquireLocks` — acquire one or many locks atomically (existing locks held by the same user are refreshed; conflicts are reported).
- `releaseLocks(draftUUID, userID)` — releases all locks by a specific user when they leave.
- `releaseAllLocks(draftUUID)` — releases all locks when the draft is activated or cancelled.

---

## OData Contract

After installation, `DRAFT.DraftAdministrativeData` exposes an additional property:

| Property | Type | Description |
|---|---|---|
| `CollaborativeDraftEnabled` | `Boolean` | `true` when participants are present in the presence store |

The `@Common.DraftRoot.ShareAction` annotation is added to each collaborative entity:

```xml
<Annotation Term="Common.DraftRoot">
  <Record>
    <PropertyValue Property="ShareAction" String="Orders_ColDraftShare"/>
  </Record>
</Annotation>
```

---

## Configuration

Configure via `cds.env` (in `package.json` → `"cds"` key or `.cdsrc.json`):

```json
{
  "cds": {
    "collab": {
      "presenceTtlMs": 300000,
      "lockTtlMs": 120000,
      "cleanupIntervalMs": 30000
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `presenceTtlMs` | `300000` (5 min) | Time after last heartbeat before a participant is evicted |
| `lockTtlMs` | `120000` (2 min) | Time after last PATCH before a field lock expires |
| `cleanupIntervalMs` | `30000` (30 s) | How often the cleanup timer runs |

---

## Limitations

### No Real-Time Push

SAP Fiori Elements Collaborative Draft in ABAP RAP uses **WebSockets** (ABAP Push Channel / SAPUI5 low-level messaging) to push presence and lock updates to all connected clients in real time.

CAP Node.js does not include a built-in WebSocket layer. This plugin therefore implements a **pull-based** model:

- Presence and lock state are available via standard OData `GET` requests on `DraftAdministrativeData`.
- Clients must poll to see updates from other participants.
- The Fiori Elements client can be configured with `@Common.SideEffects` to trigger re-reads.

Real-time push would require a WebSocket adapter (e.g., Socket.IO) and is out of scope for this plugin.

### ShareAction Not Registered

The `@Common.DraftRoot.ShareAction` annotation references a custom OData action (e.g., `Orders_ColDraftShare`). This plugin adds the annotation but does not register the OData action. The ABAP RAP ShareAction is used by Fiori Elements to trigger the collaborative invite flow. Without a custom OData action handler, this button will appear but do nothing.

To implement it, register a custom action on your service:

```cds
action Orders_ColDraftShare(DraftUUID: UUID, Recipients: array of String) returns Boolean;
```

### Fiori Elements Collaborative UI

Whether the Fiori Elements client shows participant avatars and field-lock indicators depends on the Fiori Elements version and the OData contract. The collaborative draft UI in Fiori Elements List Report / Object Page:

- Requires `CollaborativeDraftEnabled: true` in the `DraftAdministrativeData` response.
- Requires the `@Common.DraftRoot.ShareAction` annotation.
- May require WebSocket connectivity for real-time updates (degrades gracefully to no real-time).

This plugin satisfies the OData contract. Whether the FE client activates the collaborative UI depends on the specific UI5 / Fiori Elements version.

### Single CAP Instance

The in-memory presence store is per-process. In a multi-instance deployment, participants from different instances will not see each other's presence in memory. The `DRAFT.DraftParticipants` DB table is authoritative and cross-instance-consistent; the in-memory store is a cache. In a multi-instance deployment, consider loading participant state from DB more aggressively (the `loadFromDB()` is currently called only at startup).

---

## Compatibility

| Dependency | Version |
|---|---|
| `@sap/cds` | `>= 8.0` |
| `@cap-js/sqlite` | `>= 2.0` (for tests) |
| Node.js | `>= 18` |

---

## Development & Testing

```bash
# Run integration tests
npm test

# Start the test app
cd test/app && npx cds-serve

# Check metadata
curl http://localhost:4004/odata/v4/order/$metadata | grep -o 'CollaborativeDraftEnabled\|ShareAction'

# Check DraftAdministrativeData for a specific draft
curl "http://localhost:4004/odata/v4/order/Orders(ID=<uuid>,IsActiveEntity=false)/DraftAdministrativeData"
```

---

## License

Apache-2.0
