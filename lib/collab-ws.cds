/**
 * WebSocket service for real-time collaborative draft events.
 * Auto-registered by the cap-collaborative-draft plugin when
 * @cap-js-community/websocket is installed.
 *
 * Consumers do NOT need to create or reference this service manually.
 */
@protocol: 'ws'
@path: '/ws/collab-draft'
@ws.format: 'pcp'
service CollabDraftWebSocketService {

    @ws.pcp.action: 'CollaborativePresenceChanged'
    event CollaborativePresenceChanged : {
        ID : UUID;
        IsActiveEntity : Boolean;
        serverAction : String;
        sideEffectSource : String;
        sideEffectEventName : String;
    }

    @ws.pcp.action: 'CollaborativeDraftChanged'
    event CollaborativeDraftChanged : {
        ID : UUID;
        IsActiveEntity : Boolean;
        serverAction : String;
        sideEffectSource : String;
        sideEffectEventName : String;
    }
}
