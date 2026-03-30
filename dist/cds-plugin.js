'use strict';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const cds = require("@sap/cds");
const model_augmenter_1 = require("./lib/model-augmenter");
const draft_handlers_1 = require("./lib/draft-handlers");
const presence = __importStar(require("./lib/presence"));
const LOG = cds.log('collab-draft');
// Auto-register the WebSocket service if @cap-js-community/websocket is installed.
const _wsAvailable = (() => {
    try {
        require.resolve('@cap-js-community/websocket', { paths: [process.cwd(), __dirname] });
        return true;
    }
    catch {
        return false;
    }
})();
/**
 * Injects the CollabDraftWebSocketService definition directly into a compiled CSN.
 */
function _injectWsServiceIntoCSN(csn) {
    if (!csn.definitions)
        csn.definitions = {};
    csn.definitions['CollabDraftWebSocketService'] = {
        kind: 'service',
        '@protocol': 'ws',
        '@path': '/ws/collab-draft',
        '@ws.format': 'pcp'
    };
    const _eventElements = {
        ID: { kind: 'element', type: 'cds.UUID' },
        IsActiveEntity: { kind: 'element', type: 'cds.Boolean' },
        serverAction: { kind: 'element', type: 'cds.String' },
        sideEffectSource: { kind: 'element', type: 'cds.String' },
        sideEffectEventName: { kind: 'element', type: 'cds.String' },
        userID: { kind: 'element', type: 'cds.String' },
        userDescription: { kind: 'element', type: 'cds.String' }
    };
    csn.definitions['CollabDraftWebSocketService.CollaborativePresenceChanged'] = {
        kind: 'event',
        '@ws.pcp.action': 'CollaborativePresenceChanged',
        elements: { ..._eventElements }
    };
    csn.definitions['CollabDraftWebSocketService.CollaborativeDraftChanged'] = {
        kind: 'event',
        '@ws.pcp.action': 'CollaborativeDraftChanged',
        elements: { ..._eventElements }
    };
    csn.definitions['CollabDraftWebSocketService.wsConnect'] = {
        kind: 'action',
        params: {}
    };
    const _msgFields = {
        userAction: { type: 'cds.String' },
        clientAction: { type: 'cds.String' },
        clientContent: { type: 'cds.String' },
        clientTriggeredActionName: { type: 'cds.String' },
        clientRefreshListBinding: { type: 'cds.String' },
        clientRequestedProperties: { type: 'cds.String' },
        userID: { type: 'cds.String' },
        userDescription: { type: 'cds.String' }
    };
    csn.definitions['CollabDraftWebSocketService.MESSAGE'] = {
        kind: 'action',
        '@ws.pcp.action': 'MESSAGE',
        params: { ..._msgFields }
    };
    csn.definitions['CollabDraftWebSocketService.message'] = {
        kind: 'event',
        '@ws.pcp.action': 'MESSAGE',
        elements: Object.fromEntries(Object.entries(_msgFields).map(([k, v]) => [k, { ...v, kind: 'element' }]))
    };
    LOG.debug('Auto-registered CollabDraftWebSocketService in CSN');
}
LOG.info('cap-collaborative-draft plugin loaded');
//
// ── $metadata middleware + bootstrap ─────────────────────────────────────────
//
cds.on('bootstrap', (app) => {
    // Expose /user-api/currentUser so the FLP sandbox can resolve the Shell user
    app.get('/user-api/currentUser', (req, res) => {
        let id = 'anonymous';
        const authHeader = req.headers?.authorization;
        if (authHeader?.startsWith('Basic ')) {
            try {
                id = Buffer.from(authHeader.slice(6), 'base64').toString().split(':')[0] || id;
            }
            catch { }
        }
        if (id === 'anonymous') {
            res.set('WWW-Authenticate', 'Basic realm="CAP"');
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const mockedUsers = cds.env?.requires?.auth?.users ?? {};
        const userConfig = mockedUsers[id] ?? {};
        const fullName = userConfig.displayName || (id.charAt(0).toUpperCase() + id.slice(1));
        const nameParts = fullName.trim().split(/\s+/);
        const firstName = nameParts[0] || id;
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
        res.json({
            name: id,
            displayName: fullName,
            firstName,
            lastName,
            email: `${id}@example.com`,
            isAuthenticated: true
        });
    });
    app.use((req, res, next) => {
        if (!req.path?.endsWith('/$metadata'))
            return next();
        const originalSend = res.send.bind(res);
        res.send = function (body) {
            if (typeof body !== 'string' || !body.includes('<EntityContainer'))
                return originalSend(body);
            let changed = false;
            const nsMatch = body.match(/<Schema Namespace="([^"]+)"/);
            const ns = nsMatch ? nsMatch[1] : 'self';
            // ── 1. Inject CollaborativeDraftEnabled and DraftAccessType ──
            if (!body.includes('Name="CollaborativeDraftEnabled"')) {
                body = body.replace(/(<EntityType Name="DraftAdministrativeData">[\s\S]*?)(\s*<\/EntityType>)/, (match, open, close) => {
                    const newProps = [
                        '\n        <Property Name="CollaborativeDraftEnabled" Type="Edm.Boolean"/>',
                        '\n        <Property Name="DraftAccessType" Type="Edm.String" MaxLength="1"/>'
                    ].join('');
                    return open + newProps + close;
                });
                changed = true;
                LOG.debug('Injected CollaborativeDraftEnabled/DraftAccessType into $metadata DraftAdministrativeData EntityType');
            }
            // ── 2. Inject DraftAdministrativeUser NavigationProperty into DraftAdministrativeData ──
            {
                const hasNavPropInDAD = /<EntityType Name="DraftAdministrativeData">[\s\S]*?NavigationProperty[^>]*Name="DraftAdministrativeUser"/.test(body);
                if (!hasNavPropInDAD && body.includes('EntityType Name="DraftAdministrativeData"')) {
                    body = body.replace(/(<EntityType Name="DraftAdministrativeData">[\s\S]*?)(\s*<\/EntityType>)/, (match, open, close) => {
                        const navProp = `\n        <NavigationProperty Name="DraftAdministrativeUser" Type="Collection(${ns}.DraftAdministrativeUser)" ContainsTarget="true"/>`;
                        return open + navProp + close;
                    });
                    changed = true;
                    LOG.debug('Injected DraftAdministrativeUser NavigationProperty into $metadata');
                }
            }
            // ── 3. Inject DraftAdministrativeUser EntityType (fallback) ──
            if (!body.includes('EntityType Name="DraftAdministrativeUser"')) {
                const entityType = [
                    `\n    <EntityType Name="DraftAdministrativeUser">`,
                    `\n        <Key><PropertyRef Name="DraftUUID"/><PropertyRef Name="UserID"/></Key>`,
                    `\n        <Property Name="DraftUUID" Type="Edm.Guid" Nullable="false"/>`,
                    `\n        <Property Name="UserID" Type="Edm.String" Nullable="false" MaxLength="256"/>`,
                    `\n        <Property Name="UserDescription" Type="Edm.String" MaxLength="256"/>`,
                    `\n        <Property Name="UserEditingState" Type="Edm.String" MaxLength="32"/>`,
                    `\n    </EntityType>`
                ].join('');
                body = body.replace('</Schema>', entityType + '\n</Schema>');
                changed = true;
                LOG.debug('Injected DraftAdministrativeUser EntityType into $metadata (fallback)');
            }
            // ── 4. Inject NavigationPropertyBinding for DraftAdministrativeData/DraftAdministrativeUser ──
            if (!body.includes('Path="DraftAdministrativeData/DraftAdministrativeUser"')) {
                body = body.replace(/(<EntitySet Name="(?!DraftAdministrativeUser)[^"]*"[^>]*>)([\s\S]*?)(<\/EntitySet>)/g, (match, open, inner, close) => {
                    if (!inner.includes('Path="SiblingEntity"'))
                        return match;
                    if (inner.includes('DraftAdministrativeData/DraftAdministrativeUser'))
                        return match;
                    const binding = '\n          <NavigationPropertyBinding Path="DraftAdministrativeData/DraftAdministrativeUser" Target="DraftAdministrativeUser"/>';
                    return open + inner.trimEnd() + binding + '\n        ' + close;
                });
                changed = true;
                LOG.debug('Injected DraftAdministrativeUser NavigationPropertyBinding into $metadata EntitySets');
            }
            // ── 5. Inject ColDraftShareUser ComplexType ──
            if (!body.includes('ComplexType Name="ColDraftShareUser"')) {
                const complexType = [
                    `\n    <ComplexType Name="ColDraftShareUser">`,
                    `\n        <Property Name="UserID" Type="Edm.String" MaxLength="256"/>`,
                    `\n        <Property Name="UserAccessRole" Type="Edm.String" MaxLength="1"/>`,
                    `\n    </ComplexType>`
                ].join('');
                body = body.replace('</Schema>', complexType + '\n</Schema>');
                body = body.replace(/(<Action Name="\w+_ColDraftShare"[^>]*>[\s\S]*?<Parameter Name="Users") Type="Edm\.String"(\/?>)/g, `$1 Type="Collection(${ns}.ColDraftShareUser)"$2`);
                changed = true;
                LOG.debug('Injected ColDraftShareUser ComplexType + fixed Users param in $metadata');
            }
            // ── 6. Inject ColDraftUsers EntityType + EntitySet + ValueList on ColDraftShareUser/UserID ──
            if (!body.includes('EntityType Name="ColDraftUsers"')) {
                const entityType = [
                    `\n    <EntityType Name="ColDraftUsers">`,
                    `\n        <Key><PropertyRef Name="UserID"/></Key>`,
                    `\n        <Property Name="UserID" Type="Edm.String" Nullable="false" MaxLength="256"/>`,
                    `\n        <Property Name="UserDescription" Type="Edm.String" MaxLength="256"/>`,
                    `\n    </EntityType>`
                ].join('');
                body = body.replace('</Schema>', entityType + '\n</Schema>');
                // Add EntitySet inside EntityContainer
                body = body.replace(/(<EntityContainer[^>]*>)/, `$1\n        <EntitySet Name="ColDraftUsers" EntityType="${ns}.ColDraftUsers"/>`);
                changed = true;
                LOG.debug('Injected ColDraftUsers EntityType + EntitySet into $metadata');
            }
            if (!body.includes('ColDraftShareUser/UserID')) {
                const vlAnnotation = [
                    `\n    <Annotations Target="${ns}.ColDraftShareUser/UserID">`,
                    `\n        <Annotation Term="Common.ValueList">`,
                    `\n            <Record Type="Common.ValueListType">`,
                    `\n                <PropertyValue Property="CollectionPath" String="ColDraftUsers"/>`,
                    `\n                <PropertyValue Property="Parameters">`,
                    `\n                    <Collection>`,
                    `\n                        <Record Type="Common.ValueListParameterOut">`,
                    `\n                            <PropertyValue Property="LocalDataProperty" PropertyPath="UserID"/>`,
                    `\n                            <PropertyValue Property="ValueListProperty" String="UserID"/>`,
                    `\n                        </Record>`,
                    `\n                        <Record Type="Common.ValueListParameterDisplayOnly">`,
                    `\n                            <PropertyValue Property="ValueListProperty" String="UserDescription"/>`,
                    `\n                        </Record>`,
                    `\n                    </Collection>`,
                    `\n                </PropertyValue>`,
                    `\n            </Record>`,
                    `\n        </Annotation>`,
                    `\n    </Annotations>`
                ].join('');
                body = body.replace('</Schema>', vlAnnotation + '\n</Schema>');
                changed = true;
                LOG.debug('Injected @Common.ValueList on ColDraftShareUser/UserID pointing to ColDraftUsers');
            }
            // ── 7. Inject DraftMessages EntityType + NavigationProperty + NavigationPropertyBinding ──
            // FE expects a navigable DraftMessages when @Common.DraftRoot.ShareAction is set.
            // CAP already emits DraftMessages as a structural Property (Collection of ComplexType).
            // A structural property CANNOT be addressed as a URL path segment; only NavigationProperty
            // can. So we replace the structural Property with a ContainsTarget NavigationProperty.
            //
            // Each sub-step is guarded independently (idempotent) so it works whether or not CAP
            // cached a partially-patched body from a previous request.
            // a) Replace the structural Property with a NavigationProperty (unconditional — idempotent)
            if (body.includes(`<Property Name="DraftMessages" Type="Collection(`)) {
                body = body.replace(/<Property Name="DraftMessages" Type="Collection\([^)]+\)"[^/]*\/>/g, `<NavigationProperty Name="DraftMessages" Type="Collection(${ns}.DraftMessages)" ContainsTarget="true"/>`);
                changed = true;
            }
            // b) Add our DraftMessages EntityType if not already present
            if (!body.includes('EntityType Name="DraftMessages"')) {
                const draftMsgType = [
                    `\n    <EntityType Name="DraftMessages">`,
                    `\n        <Key><PropertyRef Name="DraftUUID"/><PropertyRef Name="FieldName"/></Key>`,
                    `\n        <Property Name="DraftUUID" Type="Edm.Guid" Nullable="false"/>`,
                    `\n        <Property Name="FieldName" Type="Edm.String" MaxLength="30" Nullable="false"/>`,
                    `\n        <Property Name="IsActiveEntity" Type="Edm.Boolean"/>`,
                    `\n        <Property Name="Message" Type="Edm.String"/>`,
                    `\n        <Property Name="NumericSeverity" Type="Edm.Byte"/>`,
                    `\n        <Property Name="Target" Type="Edm.String" MaxLength="500"/>`,
                    `\n        <Property Name="Transition" Type="Edm.Boolean"/>`,
                    `\n    </EntityType>`
                ].join('');
                body = body.replace('</Schema>', draftMsgType + '\n</Schema>');
                changed = true;
            }
            // c) Add standalone EntitySet
            if (!body.includes(`EntitySet Name="DraftMessages"`)) {
                body = body.replace(/(<EntityContainer[^>]*>)/, `$1\n        <EntitySet Name="DraftMessages" EntityType="${ns}.DraftMessages"/>`);
                changed = true;
            }
            // d) Add NavigationPropertyBinding on every collaborative entity's EntitySet (idempotent)
            body = body.replace(/(<EntitySet Name="([^"]+)"[^>]*>)([\s\S]*?)(<\/EntitySet>)/g, (match, open, setName, inner, close) => {
                if (!body.includes(`${setName}_ColDraftShare`))
                    return match;
                if (inner.includes('Path="DraftMessages"'))
                    return match;
                const binding = '\n          <NavigationPropertyBinding Path="DraftMessages" Target="DraftMessages"/>';
                changed = true;
                return open + inner.trimEnd() + binding + '\n        ' + close;
            });
            if (changed)
                LOG.debug('Injected DraftMessages NavigationProperty into $metadata');
            // ── 8. Inject WebSocket annotations ──
            if (_wsAvailable && !body.includes('Common.WebSocketBaseURL')) {
                body = body.replace(/(<Annotations Target="[^"]*EntityContainer"[^>]*>)/, (match) => {
                    const wsAnnotations = [
                        '\n        <Annotation Term="Common.WebSocketBaseURL" String="/ws/collab-draft"/>',
                        '\n        <Annotation Term="Common.WebSocketChannel" Qualifier="sideEffects" String="CollaborativePresenceChanged,CollaborativeDraftChanged"/>'
                    ].join('');
                    return match + wsAnnotations;
                });
                if (!body.includes('Common.WebSocketBaseURL')) {
                    const nsMatch2 = body.match(/<Schema Namespace="([^"]+)"/);
                    const ns2 = nsMatch2 ? nsMatch2[1] : null;
                    if (ns2) {
                        const wsBlock = [
                            `\n    <Annotations Target="${ns2}.EntityContainer">`,
                            `\n        <Annotation Term="Common.WebSocketBaseURL" String="/ws/collab-draft"/>`,
                            `\n        <Annotation Term="Common.WebSocketChannel" Qualifier="sideEffects" String="CollaborativePresenceChanged,CollaborativeDraftChanged"/>`,
                            `\n    </Annotations>`
                        ].join('');
                        body = body.replace('</Schema>', wsBlock + '\n</Schema>');
                    }
                }
                changed = true;
                LOG.debug('Injected WebSocket annotations into $metadata');
            }
            // ── 8. Inject Common.SideEffects for collaborative draft events ──
            if (_wsAvailable && !body.includes('Common.SideEffects" Qualifier="CollaborativePresenceChanged"')) {
                const sideEffectsXml = [
                    '\n        <Annotation Term="Common.SideEffects" Qualifier="CollaborativePresenceChanged">',
                    '\n          <Record Type="Common.SideEffectsType">',
                    '\n            <PropertyValue Property="SourceEvents"><Collection><String>CollaborativePresenceChanged</String></Collection></PropertyValue>',
                    '\n            <PropertyValue Property="TargetProperties"><Collection><String>*</String></Collection></PropertyValue>',
                    '\n          </Record>',
                    '\n        </Annotation>',
                    '\n        <Annotation Term="Common.SideEffects" Qualifier="CollaborativeDraftChanged">',
                    '\n          <Record Type="Common.SideEffectsType">',
                    '\n            <PropertyValue Property="SourceEvents"><Collection><String>CollaborativeDraftChanged</String></Collection></PropertyValue>',
                    '\n            <PropertyValue Property="TargetProperties"><Collection><String>*</String></Collection></PropertyValue>',
                    '\n          </Record>',
                    '\n        </Annotation>'
                ].join('');
                body = body.replace(/(<Annotations Target="(\w+\.\w+)">)([\s\S]*?)(<\/Annotations>)/g, (match, open, target, inner, close) => {
                    if (target.includes('/'))
                        return match;
                    if (!inner.includes('UI.HeaderInfo'))
                        return match;
                    if (inner.includes('CollaborativePresenceChanged'))
                        return match;
                    return open + inner.trimEnd() + sideEffectsXml + '\n        ' + close;
                });
                changed = true;
                LOG.debug('Injected SideEffects annotations into $metadata');
            }
            if (changed)
                LOG.debug('$metadata patched for collaborative draft');
            return originalSend(body);
        };
        next();
    });
    //
    // ── Collaborative PATCH middleware ─────────────────────────────────────────────
    //
    app.use(async (req, res, next) => {
        if (req.method !== 'PATCH')
            return next();
        const m = req.path.match(/\/odata\/v4\/([^/]+)\/(\w+)\(([^)]+)\)$/);
        if (!m)
            return next();
        const [, svcPath, entityShortName, keyStr] = m;
        if (!keyStr.includes('IsActiveEntity=false'))
            return next();
        const idMatch = keyStr.match(/ID=([0-9a-f-]{36})/i);
        if (!idMatch)
            return next();
        const entityID = idMatch[1];
        const authHeader = req.headers?.authorization;
        let userID = null;
        if (authHeader?.startsWith('Basic ')) {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
            userID = decoded.split(':')[0];
        }
        if (!userID)
            return next();
        try {
            const db = cds.db;
            if (!db)
                return next();
            let targetSrv = null;
            for (const s of Object.values(cds.services || {})) {
                const paths = Array.isArray(s.path) ? s.path : [s.path];
                if (paths.some((p) => p?.endsWith('/' + svcPath) || p === '/' + svcPath)) {
                    targetSrv = s;
                    break;
                }
            }
            if (!targetSrv)
                return next();
            const entity = targetSrv.entities?.[entityShortName];
            if (!entity)
                return next();
            let draftUUID = null;
            const baseTable = entity.name.replace(/\./g, '_');
            for (const tbl of [`${baseTable}_drafts`, baseTable]) {
                try {
                    const isActiveClause = tbl.endsWith('_drafts') ? '' : ' AND IsActiveEntity = 0';
                    const row = await db.run(`SELECT DraftAdministrativeData_DraftUUID FROM ${tbl} WHERE ID = ?${isActiveClause}`, [entityID]);
                    const val = Array.isArray(row) ? row[0]?.DraftAdministrativeData_DraftUUID : row?.DraftAdministrativeData_DraftUUID;
                    if (val) {
                        draftUUID = val;
                        break;
                    }
                }
                catch { /* column may not exist in this table variant, try next */ }
            }
            if (!draftUUID)
                return next();
            const adminRows = await db.run(`SELECT DraftAccessType FROM DRAFT_DraftAdministrativeData WHERE DraftUUID = ?`, [draftUUID]);
            const accessType = Array.isArray(adminRows) ? adminRows[0]?.DraftAccessType : adminRows?.DraftAccessType;
            if (accessType !== 'S')
                return next();
            await db.run(`UPDATE DRAFT_DraftAdministrativeData SET InProcessByUser = ? WHERE DraftUUID = ?`, [userID, draftUUID]);
            LOG.debug(`Pre-set InProcessByUser=${userID} for collaborative draft ${draftUUID}`);
        }
        catch (err) {
            LOG.debug('Could not pre-set InProcessByUser in middleware:', err.message);
        }
        next();
    });
});
//
// ── Phase 1: Raw CSN Augmentation ────────────────────────────────────────────
//
cds.on('loaded', (csn) => {
    try {
        (0, model_augmenter_1.augmentModel)(csn);
        if (_wsAvailable && !csn.definitions?.['CollabDraftWebSocketService']) {
            _injectWsServiceIntoCSN(csn);
        }
    }
    catch (err) {
        LOG.error('Failed to augment raw CSN:', err.message, err.stack);
    }
});
//
// ── Phase 2: Handler Registration ─────────────────────────────────────────────
//
cds.on('served', async (services) => {
    if (cds.model) {
        (0, model_augmenter_1.augmentCompiledModel)(cds.model);
    }
    for (const srv of Object.values(services)) {
        if (!srv.entities?.DraftAdministrativeData)
            continue;
        const collaborativeEntities = (0, draft_handlers_1.getCollaborativeEntities)(srv);
        if (collaborativeEntities.size === 0)
            continue;
        LOG.info(`Collaborative draft enabled for ${srv.name} [ ${[...collaborativeEntities].join(', ')} ]`);
        srv.prepend(() => {
            (0, draft_handlers_1.registerHandlers)(srv, collaborativeEntities);
        });
    }
    presence.startCleanup();
    if (_wsAvailable) {
        try {
            const wsService = await cds.connect.to('CollabDraftWebSocketService');
            if (wsService) {
                wsService.on('wsConnect', async (msg) => {
                    const ws = cds.context?.ws?.socket;
                    if (!ws)
                        return;
                    try {
                        const qo = ws.request?.queryOptions || {};
                        const uid = qo.userID;
                        const uname = qo.userName;
                        if (uid) {
                            const mockedUsers = cds.env?.requires?.auth?.users ?? {};
                            ws._collabUser = {
                                id: uid,
                                name: uname || mockedUsers[uid]?.displayName || (uid.charAt(0).toUpperCase() + uid.slice(1))
                            };
                            ws._collabDraft = qo.draft || null;
                            LOG.debug(`WS connected: tagged socket with user ${uid} (draft=${qo.draft})`);
                        }
                        else {
                            ws._collabDraft = qo.draft || null;
                            LOG.debug(`WS connected: no userID in queryOptions (keys: ${Object.keys(qo).join(',')})`);
                        }
                    }
                    catch (e) {
                        LOG.debug('wsConnect tagging error:', e.message);
                    }
                });
                wsService.on('MESSAGE', async (msg) => {
                    const d = msg.data || {};
                    const wsSocket = cds.context?.ws?.socket;
                    let userId = wsSocket?._collabUser?.id || 'anonymous';
                    let userName = wsSocket?._collabUser?.name || '';
                    let draftUUID = null;
                    if (userId === 'anonymous') {
                        try {
                            const qo = wsSocket?.request?.queryOptions || {};
                            draftUUID = qo.draft || wsSocket?._collabDraft || null;
                            if (qo.userID) {
                                userId = qo.userID;
                                userName = qo.userName || '';
                            }
                            if (userId === 'anonymous') {
                                const authHeader = wsSocket?.request?.headers?.authorization;
                                if (authHeader?.startsWith('Basic ')) {
                                    userId = Buffer.from(authHeader.slice(6), 'base64').toString().split(':')[0] || 'anonymous';
                                }
                            }
                            if (userId === 'anonymous' && draftUUID) {
                                const participants = presence.getParticipants(draftUUID);
                                if (participants.length === 1) {
                                    userId = participants[0].userID;
                                    userName = participants[0].displayName || '';
                                }
                                else if (participants.length > 1) {
                                    const sorted = [...participants].sort((a, b) => b.lastSeen - a.lastSeen);
                                    userId = sorted[0].userID;
                                    userName = sorted[0].displayName || '';
                                }
                            }
                            if (!userName && userId !== 'anonymous') {
                                const mockedUsers = cds.env?.requires?.auth?.users ?? {};
                                userName = mockedUsers[userId]?.displayName || (userId.charAt(0).toUpperCase() + userId.slice(1));
                            }
                            if (userId !== 'anonymous' && wsSocket) {
                                wsSocket._collabUser = { id: userId, name: userName };
                            }
                        }
                        catch (e) {
                            LOG.debug('MESSAGE user resolve error:', e.message);
                        }
                    }
                    if (!draftUUID) {
                        draftUUID = wsSocket?.request?.queryOptions?.draft || wsSocket?._collabDraft || null;
                    }
                    const relayData = {
                        userAction: d.clientAction || '',
                        clientAction: d.clientAction || '',
                        clientContent: d.clientContent || '',
                        clientTriggeredActionName: d.clientTriggeredActionName || '',
                        clientRefreshListBinding: d.clientRefreshListBinding || '',
                        clientRequestedProperties: d.clientRequestedProperties || '',
                        userID: userId,
                        userDescription: userName || userId
                    };
                    LOG.debug(`Relaying MESSAGE: ${d.clientAction} by ${userId} (${userName})`);
                    try {
                        const wsFacade = cds.context?.ws?.service;
                        if (wsFacade?.broadcast) {
                            await wsFacade.broadcast('message', relayData);
                            const wsSocket2 = cds.context?.ws?.socket;
                            const needsEcho = wsSocket2 && !wsSocket2._collabJoinEchoed;
                            if (needsEcho && ['JOIN', 'JOINECHO', 'LOCK'].includes(d.clientAction)) {
                                wsSocket2._collabJoinEchoed = true;
                                try {
                                    if (draftUUID) {
                                        const allParticipants = presence.getParticipants(draftUUID);
                                        const _mockedUsers = cds.env?.requires?.auth?.users ?? {};
                                        for (const p of allParticipants) {
                                            if (p.userID === userId)
                                                continue;
                                            const pName = _mockedUsers[p.userID]?.displayName || p.displayName || p.userID;
                                            await wsFacade.emit('message', {
                                                ...relayData,
                                                userAction: 'JOINECHO',
                                                clientAction: 'JOINECHO',
                                                userID: p.userID,
                                                userDescription: pName
                                            });
                                        }
                                    }
                                }
                                catch (e) {
                                    LOG.debug('JOINECHO error:', e.message);
                                }
                            }
                        }
                        else {
                            await wsService.emit('message', relayData);
                        }
                    }
                    catch (err) {
                        LOG.debug('MESSAGE relay failed:', err.message);
                    }
                });
                LOG.debug('Registered MESSAGE relay handler for collaborative draft WS');
            }
        }
        catch (err) {
            LOG.debug('Could not register MESSAGE relay:', err.message);
        }
    }
    const draftAdminTables = new Set(['DRAFT_DraftAdministrativeData']);
    for (const srv of Object.values(services)) {
        if (srv.entities?.DraftAdministrativeData) {
            draftAdminTables.add(`${srv.name.replace(/\./g, '_')}_DraftAdministrativeData`);
        }
    }
    setImmediate(async () => {
        try {
            const db = cds.db;
            if (!db)
                return;
            for (const sql of [
                `ALTER TABLE DRAFT_DraftAdministrativeData ADD COLUMN CollaborativeDraftEnabled BOOLEAN DEFAULT 0`,
                `ALTER TABLE DRAFT_DraftAdministrativeData ADD COLUMN DraftAccessType NVARCHAR(1) DEFAULT ''`
            ]) {
                try {
                    await db.run(sql);
                }
                catch (err) {
                    if (!err.message?.includes('duplicate column') && !err.message?.includes('already exists')) {
                        LOG.debug(`DDL migration skipped (${err.message?.slice(0, 60)})`);
                    }
                }
            }
            for (const viewName of draftAdminTables) {
                if (viewName === 'DRAFT_DraftAdministrativeData')
                    continue;
                try {
                    const rows = await db.run(`SELECT sql FROM sqlite_master WHERE type='view' AND name='${viewName}'`);
                    const viewSql = Array.isArray(rows) ? rows[0]?.sql : rows?.sql;
                    if (!viewSql)
                        continue;
                    if (viewSql.includes('CollaborativeDraftEnabled'))
                        continue;
                    const updatedViewSql = viewSql.replace(/\bFROM\b/i, `,\n  DraftAdministrativeData.CollaborativeDraftEnabled,\n  DraftAdministrativeData.DraftAccessType\nFROM`);
                    await db.run(`DROP VIEW IF EXISTS ${viewName}`);
                    await db.run(updatedViewSql);
                }
                catch (err) {
                    LOG.debug(`Could not recreate view ${viewName}: ${err.message?.slice(0, 80)}`);
                }
            }
        }
        catch (err) {
            LOG.warn('Could not run DDL migration for collaborative draft columns:', err.message);
        }
    });
    setImmediate(async () => {
        try {
            await presence.loadFromDB();
        }
        catch (err) {
            LOG.warn('Could not load participants from DB on startup:', err.message);
        }
    });
});
