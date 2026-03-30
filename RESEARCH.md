# Research Findings: cap-collaborative-draft

## 1. CAP Draft Internals

### 1.1 DraftAdministrativeData Structure

From `node_modules/@sap/cds/lib/compile/for/lean_drafts.js`:

```cds
entity DRAFT.DraftAdministrativeData {
  key DraftUUID         : UUID;
  LastChangedByUser     : String(256);
  LastChangeDateTime    : Timestamp;
  CreatedByUser         : String(256);
  CreationDateTime      : Timestamp;
  InProcessByUser       : String(256);
  DraftIsCreatedByMe    : Boolean;  // calculated: CreatedByUser = current user
  DraftIsProcessedByMe  : Boolean;  // calculated: InProcessByUser = current user AND LastChangeDateTime > timeout
}
```

Draft entities also get these additional fields (from `lean_drafts.js` `Draft` entity template):
- `IsActiveEntity` : Boolean — **virtual** (not persisted)
- `HasDraftEntity` : Boolean — **virtual** (not persisted)
- `HasActiveEntity` : Boolean — **NOT virtual** (persisted; comment in source: "This should be written !!!")
- `DraftAdministrativeData_DraftUUID` : UUID (FK, persisted)
- `DraftAdministrativeData` : Association to DRAFT.DraftAdministrativeData (managed via FK above)
- `SiblingEntity` : **commented out** in the Draft entity template in lean_drafts.js — may be added elsewhere, not confirmed

### 1.2 Draft Database Tables

For an entity `Orders` with `@odata.draft.enabled`, CAP creates:
- Active table: `Orders` (main data)
- Draft table: `Orders_drafts` (copy of data + draft columns)
- `DRAFT_DraftAdministrativeData` (shared admin table for all drafts)

### 1.3 Draft Handler Chain (lean-draft.js)

The module exports a `cds.service.impl()` that:
1. Checks `this.entities?.DraftAdministrativeData` — exits if no draft-enabled entities
2. Overrides `this.handle = draftHandle` (the core dispatch function)
3. Registers handlers via `this.prepend()` and `this.on()`:

```js
this.prepend(s => s.before('NEW', '*', beforeNew))
this.on('NEW', '*', onNew)
this.on('EDIT', '*', onEdit)
this.on('CANCEL', '*', onCancel)
this.on('draftPrepare', '*', onPrepare)
```

**Note:** `draftActivate` is handled inside `draftHandle` directly, not via `this.on()`.

### 1.4 EDIT Handler — Lock Check (lines 2187-2286)

The `onEdit` function:
1. Creates a new `DraftUUID`
2. Selects existing draft via `existingDraft = SELECT.one({ ref: draftsRef }).columns({ ref: ['DraftAdministrativeData'], expand: [_inProcessByUserXpr(_lock.shiftedNow)] })`
3. The `InProcessByUser` field uses a calculated expression that returns NULL if the lock has expired (`LastChangeDateTime > shiftedNow`)
4. **Key check:** `if (inProcessByUser || preserveChanges) cds.error({ status: 409, message: 'DRAFT_ALREADY_EXISTS' })`
5. `inProcessByUser` is NULL if lock expired → draft gets overwritten; non-null → error thrown

**For collaborative draft:** We need to intercept BEFORE this handler runs, detect the entity is collaborative-draft-enabled, and instead of blocking, join the existing draft.

### 1.5 PATCH Handler — Lock Check (lines 1085-1138)

The PATCH handler:
1. Selects draft admin data with `InProcessByUser`
2. Check: `if (!cds.context.user._is_privileged && res.DraftAdministrativeData?.InProcessByUser !== cds.context.user.id)` → `DRAFT_LOCKED_BY_ANOTHER_USER`
3. Applies update, then updates `DraftAdministrativeData` with `InProcessByUser: req.user.id`

**For collaborative draft:** We need to skip this check (all participants are allowed) and instead check our own field-level locks.

### 1.6 draftActivate Handler (lines 897-1015)

Checks: `res.DraftAdministrativeData?.InProcessByUser !== cds.context.user.id` → error.

**For collaborative draft:** We need to allow any participant (not just InProcessByUser) to activate.

### 1.7 Plugin Loading Mechanism

From `lib/plugins.js`:
- CAP scans project's `dependencies` and `devDependencies`
- For each, tries `require.resolve(each + '/cds-plugin', { paths: [root] })`
- If found, loads the module (it's just `require()`d — the module's side effects run)
- The module should call `cds.on(...)` lifecycle hooks

**To be a plugin:** The package needs a `cds-plugin.js` at root, and must be in the app's `dependencies` or `devDependencies`.

### 1.8 CSN Manipulation in `cds.on('loaded')`

The `cds.on('loaded', csn => {...})` hook fires after CSN compilation. The `csn` object is the compiled model with `definitions` property. You can directly mutate the CSN object to add/modify entities and their elements.

Example pattern from @cap-js packages:
```js
cds.on('loaded', csn => {
  const { definitions } = csn
  // Add new entity
  definitions['MyNewEntity'] = { kind: 'entity', elements: {...} }
  // Modify existing entity
  definitions['DRAFT.DraftAdministrativeData'].elements['NewField'] = { type: 'cds.Boolean' }
})
```

### 1.9 `InProcessByUser` Calculated Expression

The lock timeout is `cds.env.fiori.draft_lock_timeout` (default: 15 minutes). The `InProcessByUser` is returned as NULL if the draft hasn't been touched within that window. This means CAP's own lock timeout would release our collaborative draft participants after 15min of inactivity.

## 2. Fiori Elements Collaborative Draft Contract

### 2.1 Enabling Collaborative Draft

The `@Common.DraftRoot` annotation must include a `ShareAction` property pointing to a bound action:

```xml
<Annotation Term="Common.DraftRoot">
  <Record Type="Common.DraftRootType">
    <PropertyValue Property="ActivationAction" String="ServiceName.draftActivate"/>
    <PropertyValue Property="EditAction" String="ServiceName.draftEdit"/>
    <PropertyValue Property="PreparationAction" String="ServiceName.draftPrepare"/>
    <PropertyValue Property="ShareAction" String="ServiceName.ColDraftShare"/>
  </Record>
</Annotation>
```

The `ShareAction` named action must match `Template_ShareAction` signature.

### 2.2 WebSocket-Based Synchronization

**Critical finding:** Fiori Elements uses **WebSockets** (ABAP Push Channel Protocol) for real-time synchronization between collaborative draft participants. The `@Common.WebSocketBaseURL` annotation specifies the WebSocket endpoint.

Without WebSocket support, participants will NOT see each other's changes in real-time. The FE client opens a WebSocket connection when it detects a `ShareAction` in the `DraftRoot` annotation.

**Implication for this plugin:** We cannot fully replicate the collaborative draft UI behavior without WebSocket support. However, we can:
1. Implement the OData API layer (join draft, field locks, participants)
2. Add proper `@Common.DraftRoot.ShareAction` annotation
3. Implement polling-based updates via `DraftAdministrativeData` READ
4. Document the WebSocket limitation clearly

### 2.3 Participant Display (Avatars)

The FE client shows participant avatars in the object page header via two mechanisms:

**1. OData read on `DraftAdministrativeData/DraftAdministrativeUser`:**
FE reads participants with `$select: UserID,UserDescription,UserEditingState` and filters out the current user (`UserID ne '<currentUser>'`). This populates the avatar group in the header.

**2. WebSocket PCP collaboration protocol (MESSAGE relay):**
The FE sends and receives PCP messages with `pcp-action: MESSAGE` containing collaboration activities (JOIN, LEAVE, LOCK, CHANGE, DISCARD, ACTIVATE). When the server relays these messages to all connected clients, the FE processes them to:
- Add/remove user avatars in real-time
- Show field lock indicators (grayed-out fields with editing user's avatar)
- Synchronize changes between participants

The MESSAGE relay is critical — without it, avatars only appear on initial load (from the OData read) and never update dynamically. The server must register a `MESSAGE` event on the WebSocket service (`@ws.pcp.action: 'MESSAGE'`) and broadcast incoming messages to all connected WS clients.

**Originator determination:**
The DB's `DraftAdministrativeData.CreatedByUser` is the source of truth for who is the originator. The in-memory presence store's `isOriginator` flag can become stale when users re-join via `ColDraftShare` (which always sets `originator: false`). The CANCEL handler must check `CreatedByUser` from DB to correctly determine if the discard should delete the draft (originator) or just remove the participant (collaborator).

### 2.4 Field-Level Locking

When a user focuses on a field:
- The FE sends a **WebSocket PCP MESSAGE** with `userAction: "LOCK"` and the field path — NOT an OData PATCH or dedicated action. Lock indication is purely WS-driven.
- The server must relay this LOCK message to all other connected participants.
- Other users' UI shows a lock indicator in real-time via the relayed WS message.
- When the field loses focus, FE sends `userAction: "UNLOCK"`.
- The backend also tracks locks in `DRAFT.DraftFieldLocks` (DB-persisted) and enforces them via 409 on conflicting PATCH.
- After inactivity (TTL), DB locks expire via a scheduled cleanup.

The field lock mechanism is custom — not part of standard OData draft. It requires both WS relay (real-time) and DB enforcement (conflict rejection on PATCH).

### 2.5 DraftAdministrativeData Additional Fields

The collaborative draft adds at least one additional element to `DraftAdministrativeData` (from the search result: "The collaborative draft feature initiates a database schema update, as it adds an additional element to DraftAdministrativeData"). The exact field(s) are not publicly documented but likely include `CollaborativeDraftEnabled: Boolean`.

### 2.6 Template_ShareAction Signature

The `ShareAction` is an OData action bound to the draft root entity. From the vocabulary definition, it "restricts access to the listed users in their specified roles." For our implementation, we'll implement it as a no-op action that enables the collaborative draft mode in the FE client.

## 3. RAP Collaborative Draft vs. CAP Implementation

### Key Differences

| Feature | RAP | Our CAP Plugin |
|---------|-----|----------------|
| Real-time sync | WebSocket (ABAP Push Channel) | WebSocket via `@cap-js-community/websocket` (PCP-compatible) |
| Participant avatars | Pushed via WebSocket | WS JOINECHO relay + OData DraftAdministrativeUser READ |
| Field locks | Push notifications | WS LOCK/UNLOCK relay + DB enforcement (409 on conflict) |
| Multiple users in EDIT | Native | Override `on('EDIT')` to join existing draft |
| Activate by any user | Native | Override via `srv.handle` wrapper (pre-set InProcessByUser) |

### What We CAN Implement (Implemented)

1. **Join existing draft** — Override `on('EDIT')` to allow multiple participants
2. **Field-level locks** — DB-backed (`DRAFT.DraftFieldLocks`) + WS relay for real-time indicators
3. **Participant tracking** — In-memory + DB (`DRAFT.DraftParticipants`), readable via OData navigation `DraftAdministrativeData/DraftAdministrativeUser`
4. **Merge on activate** — All participants' changes are in the same draft table (no merge needed)
5. **`@Common.DraftRoot.ShareAction`** — Bound action `<Entity>_ColDraftShare` registered and handled
6. **`CollaborativeDraftEnabled` + `DraftAccessType` flags** — Added to `DRAFT.DraftAdministrativeData`
7. **Real-time presence and field lock updates** — WS PCP MESSAGE relay to all participants
8. **User directory for invite dialog** — Static map (dev) or entity-backed (enterprise)

### What We Do NOT Implement

1. **ABAP Push Channel Protocol** — We use a PCP-compatible format via `@cap-js-community/websocket`; the wire format is compatible but not 100% identical to the ABAP APC stack
2. **Access role enforcement** — The `UserAccessRole` param on `ColDraftShare` is accepted but not enforced (all participants get read+write)

## 4. Implementation Strategy (Executed)

> **Note:** This section records the planning rationale. For the actual implemented approach, see the source files directly. Event names below reflect CDS conventions: OData PATCH maps to CDS `UPDATE`, not `PATCH`.

### 4.1 Model Augmentation

Extend `DRAFT.DraftAdministrativeData` in CSN (raw) and compiled model with:
- `CollaborativeDraftEnabled: Boolean`
- `DraftAccessType: String(1)` — `'S'` = shared/collaborative

Create new DB-persisted entities:
- `DRAFT.DraftParticipants` — participants per draft
- `DRAFT.DraftFieldLocks` — field-level locks

Add `@Common.DraftRoot.ShareAction` annotation to draft-enabled entities.

### 4.2 Handler Strategy

Use `cds.on('served')` to intercept services with collaborative draft entities. Register handlers via `srv.prepend()` to run before lean-draft's built-in handlers.

Key handlers:
- `on('EDIT')` — intercept to join existing drafts instead of blocking
- `before('UPDATE')` — field-level lock check (CDS event for OData PATCH is `UPDATE`, not `PATCH`)
- `before('draftActivate')` — capture DraftUUID on `req` for after-handler cleanup
- `on('CANCEL')` — originator vs. collaborator leave logic

### 4.3 EDIT Override (on vs. before)

Using `on('EDIT')` via `prepend()` so our handler runs FIRST in the ON phase, before lean-draft's `on('EDIT')`:
- If draft exists: join the existing draft, return draft data, skip next()
- If no draft: call `next()`, then register as originator in `after('EDIT')`

### 4.4 PATCH / InProcessByUser Bypass

CAP lean-draft checks `InProcessByUser !== currentUser` on PATCH. Bypass via `srv.handle` wrapper: before delegating to the original handle, update `InProcessByUser` to the current user in `DRAFT_DraftAdministrativeData` via raw SQL. This runs BEFORE lean-draft's check and makes it pass for all collaborative participants.

The `_is_privileged` approach was considered but rejected — it bypasses too many checks and requires access to CAP internals.

## 5. Critical Constraints Identified

1. **lean-draft uses `this.handle = draftHandle`** — this overrides the dispatch entirely. Our `before()` handlers registered via `prepend()` should still run because `draftHandle` calls `protoHandle` which goes through the middleware chain.

2. **`InProcessByUser` check** — The most invasive check. We'll update it before PATCH runs.

3. **draftActivate is NOT a registered handler** — it's handled inside `draftHandle` directly. To override it, we need a different approach. We can use `before('draftActivate')` which DOES get called (line 611 shows `req.event = 'draftActivate'` is set).

4. **DRAFT_ALREADY_EXISTS check** — In `onEdit`, this runs AFTER we check `existingDraft`. To intercept, we need our handler to run and return before `onEdit` gets control. Using `this.on('EDIT', ...)` via `prepend()` would put our handler in front of lean-draft's `on('EDIT')`.

## 6. Plugin Package.json Configuration

The plugin needs to be listed in the consumer app's `package.json` as a dependency. For the test app, we'll use `"cap-collaborative-draft": "file:../.."` in `devDependencies`. The plugin itself needs `cds-plugin.js` at root.

No special `cds` key needed in `package.json` — the plugin auto-discovery just needs the file to exist.

---

## 7. Fiori Elements Collaborative Draft — FE Client Internals

### 7.1 User Identity Resolution

The FE collaboration module resolves the current user via `getMe()` in `sap/fe/core/controllerextensions/collaboration/CollaborationCommon.js`:

```js
function getMe(appComponent) {
  const shellServices = appComponent.getShellServices();
  if (shellServices?.hasUShell()) {
    initials = shellServices.getUserInitials();
    id = shellServices.getUser().getId();
    name = shellServices.getUser().getFullName();
  } else if (window.adt) {
    // SAP ADT (Eclipse) path
  } else {
    throw "No Shell... No User";
  }
  return { initials, id, name, color: "Accent6", me: true, status: "CurrentlyEditing" };
}
```

**Implication:** The avatar displayed in the Object Page header is determined by `sap.ushell.Container.getUser()`, NOT by the OData service's authenticated user. In the FLP sandbox, this defaults to "Default User" (DU) unless the sandbox config overrides it.

**Fix for local testing:** Configure `sap-ushell-config.services.Container.adapter.config` with `id`, `firstName`, `fullName`, `email` matching the CAP mocked auth user. The `flpSandbox.html` reads `?sap-user=alice` from the URL to parameterize this.

### 7.2 ShareAction (ColDraftShare) — FE Contract

FE automatically invokes the ShareAction when entering a collaborative draft Object Page. Two functions are used:

**`addSelf(context)`** — Called on initial draft entry:
```js
const shareAction = metaModel.getObject(`${metaPath}@Common.DraftRoot/ShareAction`);
const binding = model.bindContext(`${shareAction}(...)`, context);
binding.setParameter("Users", []);
binding.setParameter("ShareAll", true);
binding.setParameter("IsDeltaUpdate", true);
binding.setParameter("If-Match", "*");
binding.invoke();
```

**`shareObject(context, users)`** — Called from the "Invite Users" dialog:
```js
binding.setParameter("Users", users);  // Array of { UserID: "..." }
binding.setParameter("ShareAll", true);
binding.invoke("$auto.Workers");
```

**Required OData action signature:**
```xml
<Action Name="Orders_ColDraftShare" IsBound="true">
  <Parameter Name="in" Type="OrderService.Orders"/>
  <Parameter Name="Users" Type="Collection(OrderService.ColDraftShareUser)"/>
  <Parameter Name="ShareAll" Type="Edm.Boolean"/>
  <Parameter Name="IsDeltaUpdate" Type="Edm.Boolean"/>
</Action>

<ComplexType Name="ColDraftShareUser">
  <Property Name="UserID" Type="Edm.String" MaxLength="256"/>
</ComplexType>
```

Without the `ColDraftShareUser` ComplexType, the "Search User" value-help crashes with:
```
No metadata for /Edm.String/UserID
Cannot read properties of undefined (reading '@com.sap.vocabularies.Common.v1.ValueListRelevantQualifiers')
```

### 7.3 Participant Display in Header

FE reads participants via OData navigation `DraftAdministrativeData/DraftAdministrativeUser`:

```js
// In executeShareAction and activateCollaboration:
findOrCreateRootContext(context, "Draft", view, appComponent, {
  $$groupId: context.getGroupId(),
  $select: "DraftAdministrativeData/DraftAdministrativeUser"
});

// In readInvitedUsers:
model.bindList("DraftAdministrativeData/DraftAdministrativeUser", 
  view.getBindingContext(), [], [],
  { $select: "UserID,UserDescription,UserEditingState" });
```

**Expected `UserEditingState` values** (from CollaborationCommon.js):
- `"N"` — NoChanges — user is present but has not yet made changes
- `"P"` — InProgress — user has made changes

The discard dialog shows users with `"P"` under "Changes Made" (status 2) and excludes users with `"N"` or any unrecognized value. `"Originator"` and `"Collaborator"` are NOT valid state values for FE — they are not in the enum and fall through to default (excluded from the dialog list).

**Current implementation** returns `"P"` for all participants (conservative — treats every joined user as having potentially changed data). This is correct behavior.

### 7.4 WebSocket SideEffects for Live Updates

FE's WS-driven SideEffects require four elements in `$metadata`:

1. **EntityContainer annotations:**
```xml
<Annotation Term="Common.WebSocketBaseURL" String="/ws/collab-draft"/>
<Annotation Term="Common.WebSocketChannel" Qualifier="sideEffects" 
  String="CollaborativePresenceChanged,CollaborativeDraftChanged"/>
```

2. **EntityType annotations (NOT EntitySet!):**
```xml
<Annotations Target="OrderService.Orders">
  <Annotation Term="Common.SideEffects" Qualifier="CollaborativeDraftChanged">
    <Record Type="Common.SideEffectsType">
      <PropertyValue Property="SourceEvents">
        <Collection><String>CollaborativeDraftChanged</String></Collection>
      </PropertyValue>
      <PropertyValue Property="TargetProperties">
        <Collection><String>*</String></Collection>
      </PropertyValue>
    </Record>
  </Annotation>
</Annotations>
```

3. **WebSocket PCP payload:**
```json
{
  "serverAction": "RaiseSideEffect",
  "sideEffectSource": "/Orders(ID=<uuid>,IsActiveEntity=false)",
  "sideEffectEventName": "CollaborativeDraftChanged",
  "userID": "bob",
  "userDescription": "Bob"
}
```

4. **WS service with PCP format:**
The WS service must be registered with `@protocol: 'ws'` and `@ws.format: 'pcp'`.

**Critical: SideEffects annotations must be on the EntityType target** (`OrderService.Orders`), not the EntitySet target (`OrderService.EntityContainer/Orders`). FE resolves SideEffects from the metamodel EntityType path, and EntitySet-targeted annotations are NOT matched.

**Manifest setting for silent WS-triggered refresh:**

```json
"sap.fe": {
  "app": {
    "sideEffectsEventsInteractionType": {
      "default": "None"
    }
  }
}
```

Without this, FE shows a confirmation dialog or notification to the user on every WS-triggered SideEffect refresh. `"None"` suppresses all UI interaction and refreshes silently. The key is nested under `sap.fe` → `app` in `manifest.json`.

### 7.5 FLP Sandbox Limitations for Local Testing

The FLP sandbox (`test-resources/sap/ushell/bootstrap/sandbox.js`) provides a real Shell with user context, but has limitations:

1. **User identity is static per page load.** The sandbox user is configured in `sap-ushell-config.services.Container.adapter.config` and cannot change after bootstrap. To test multi-user, each user needs a separate browser window with a different `?sap-user=` parameter.

2. **The standalone `index.html` does NOT provide Shell context.** Only the FLP sandbox bootstraps `sap.ushell` properly. The custom ushell shim approach (patching `window.sap.ushell.Container`) is insufficient — the FE collaboration module requires services like `getShellServices().hasUShell()` and `getUser()` to be real shell implementations, not plain objects.

3. **Browser automation cannot handle HTTP Basic Auth.** For automated testing, auth must be disabled or a different auth strategy used.

### 7.6 FE Collaborative Draft Initialization Flow

When the user navigates to a draft Object Page:

1. **`activateCollaboration()`** — Checks if collab draft is supported via `$metadata` (`DraftRoot/ShareAction` present). Reads `DraftAdministrativeData/DraftAdministrativeUser`.
2. **`executeShareAction()`** — Calls `addSelf()` which invokes the ShareAction with `Users: [], ShareAll: true` to register the current user.
3. **WebSocket connection** — FE opens `ws://<host>/ws/collab-draft?draft=<draftUUID>` (confirmed params: `draft`, optionally `userID` and `userName` when `?useFLPUser=true` is in the page URL). The `relatedService` param seen in some documentation is **not confirmed** from source analysis.
4. **`readInvitedUsers()`** — Reads participant list from `DraftAdministrativeData/DraftAdministrativeUser`, filters out current user.
5. **Avatar group** — Renders avatars for all participants in the header.

### 7.7 FE Source Analysis: UI5 Collaborative Draft Internals

Based on analysis of `CollaborationDraft.tsx`, `CollaborationDiscardDialog.tsx`, `CollaborationCommon.ts`, and `ActivityBase.ts`:

#### UserEditingState Enum

FE uses an internal enum (NOT Originator/Collaborator):

```ts
enum UserEditingState { NoChanges = "N", InProgress = "P" }
```

The discard dialog uses this to classify users:

- Active WS users → `CurrentlyEditing` (status 3)
- Non-active users with `UserEditingState === "P"` → `ChangesMade` (status 2)
- Users with `UserEditingState === "N"` or any other value → excluded from dialog list

Backend must return `"P"` for all users who have joined and potentially edited, `"N"` for users who haven't made changes yet.

#### WS User Identity via URL Parameters

`ActivityBase.ts` (line 55-62): When `?useFLPUser=true` is on the page URL, the FE includes `userID` and `userName` in the WS connection URL:

```ts
const additionalParameters = { draft: draftUUID };
if (sendUserInfo || new URLSearchParams(window.location.search).get("useFLPUser") === "true") {
    additionalParameters["userID"] = user.id;
    additionalParameters["userName"] = user.initialName ?? "";
}
```

This eliminates the need for auth-header parsing on the WS upgrade request. The backend parses `userID` and `userName` from the WS URL query params.

#### ColDraftShareUser Type

FE's invite action sends users with `UserAccessRole`:

```ts
users.push({ UserID: context.getProperty("id"), UserAccessRole: "O" });
```

The `ColDraftShareUser` complex type must include both `UserID` (string) and `UserAccessRole` (string, max 1 char). `"O"` = Owner role.

#### Value Help on User Search Field

`getValueHelpDelegate()` builds a property path `/<ComplexType>/UserID` and configures the FE ValueHelpDelegate. If no `@Common.ValueListRelevantQualifiers` annotation exists on `ColDraftShareUser/UserID`, the delegate may crash. An empty `ValueListRelevantQualifiers` collection prevents this.

#### formatInitials Logic

`CollaborationCommon.ts` (line 79-96): Derives avatar initials from a full name string:

- Strips academic titles (Dr., Prof., etc.)
- 2+ words: first char of first word + first char of last word → e.g. "Alice Cipher" → "AC"
- 1 word: first 2 characters → e.g. "Bob" → "BO"
- Result uppercased

The FLP sandbox `Container.adapter.config` must set `firstName`/`lastName` to match this logic for the Shell avatar to be consistent with FE's collaborative avatars.

#### Display Name in WS Messages

The `userDescription` field in WS MESSAGE relay must contain the user's full name (as returned by `getUser().getFullName()`). FE passes it to `formatInitials()` for avatar display. Do NOT append suffixes like " User" — it changes the initials (e.g. "Bob User" → "BU" instead of "BO").

### 7.8 Known Gaps vs RAP

| Feature | RAP | This Plugin | Status |
| ------- | --- | ---------- | ------ |
| User identity in header | XSUAA/IDP | FLP sandbox `?useFLPUser=true` + `/user-api/currentUser` | Working |
| Share dialog — user search | Full user search via IDP | Entity-backed (`cds.env.collab.users.entity`) or static map | Working |
| Live field updates via WS | ABAP Push Channel | `@cap-js-community/websocket` PCP MESSAGE relay | Working |
| Field-level lock indicators | Backend-driven LOCK/UNLOCK | WS MESSAGE LOCK relay + 409 conflict on PATCH | Working |
| Participant avatars in header | Full avatar group | JOINECHO + OData DraftAdministrativeUser | Working |
| Discard confirmation dialog | Shows all participants with status | UserEditingState `"P"` for all joined users | Working |
| Access role enforcement | Owner/Collaborator roles | `UserAccessRole` accepted but not enforced | Not implemented |
| Multi-node presence | Redis or cluster-aware store | In-memory Map (single-node only) | Not implemented |
