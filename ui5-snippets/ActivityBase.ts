import type { FEView } from "sap/fe/core/BaseController";
import type { Message, User } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import { Activity } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import { getResourceModel } from "sap/fe/core/helpers/ResourceModelHelper";
import type { WebSocketParameter } from "sap/fe/core/helpers/WebSocket";
import { ChannelType, WEBSOCKET_STATUS, createWebSocket } from "sap/fe/core/helpers/WebSocket";
import MessageBox from "sap/m/MessageBox";
import type Event from "sap/ui/base/Event";
import type SapPcpWebSocket from "sap/ui/core/ws/SapPcpWebSocket";
import type { WebSocket$CloseEvent, WebSocket$MessageEvent } from "sap/ui/core/ws/WebSocket";
import type JSONModel from "sap/ui/model/json/JSONModel";

const COLLABORATION = "/collaboration";
const CONNECTION = "/collaboration/connection";
const CURRENTDRAFTID = "/collaboration/DraftID";
const WEBSOCKETSTATUS = "/collaboration/websocket_status";

export function isCollaborationConnected(internalModel: JSONModel): boolean {
	return internalModel.getProperty(WEBSOCKETSTATUS) === WEBSOCKET_STATUS.CONNECTED;
}

/**
 * Initializes the collaboration websocket.
 * @param user
 * @param draftUUID
 * @param internalModel
 * @param receiveCallback
 * @param view
 * @param sendUserInfo
 * @returns True if a new websocket was created
 */
export function initializeCollaboration(
	user: User,
	draftUUID: string,
	internalModel: JSONModel,
	receiveCallback: (_: Message) => void,
	view: FEView,
	sendUserInfo = false
): boolean {
	if (internalModel.getProperty(CONNECTION)) {
		// A connection is already established
		if (internalModel.getProperty(CURRENTDRAFTID) === draftUUID) {
			// Connection corresponds to the same draft -> nothing to do
			return false;
		} else {
			// There was a connection to another draft -> we close it before creating a new one
			// This can happen e.g. when switching between items in FCL
			endCollaboration(internalModel);
		}
	}

	const activeUsers: User[] = [user];
	internalModel.setProperty(COLLABORATION, { activeUsers: activeUsers, activities: {} });

	const additionalParameters: WebSocketParameter = {
		draft: draftUUID
	};
	if (sendUserInfo || new URLSearchParams(window.location.search).get("useFLPUser") === "true") {
		// used for internal testing
		additionalParameters["userID"] = user.id;
		additionalParameters["userName"] = user.initialName ?? "";
	}

	const webSocket = createWebSocket(ChannelType.CollaborationDraft, view.getController().getAppComponent(), additionalParameters);

	internalModel.setProperty(WEBSOCKETSTATUS, WEBSOCKET_STATUS.CONNECTING);
	internalModel.setProperty(CONNECTION, webSocket);
	internalModel.setProperty(CURRENTDRAFTID, draftUUID);

	webSocket.attachMessage(function (event: WebSocket$MessageEvent & Event<{ pcpFields?: Message }>): void {
		const message = event.getParameter("pcpFields");
		if (message) {
			receiveCallback(message);
		}
	});

	webSocket.attachOpen(function () {
		internalModel.setProperty(WEBSOCKETSTATUS, WEBSOCKET_STATUS.CONNECTED);
	});

	function showConnectionLostDialog(): void {
		const resourceModel = getResourceModel(view);
		const lostOfConnectionText = resourceModel.getText("C_COLLABORATIONDRAFT_CONNECTION_LOST");

		MessageBox.warning(lostOfConnectionText, {
			actions: [MessageBox.Action.OK],
			emphasizedAction: MessageBox.Action.OK
		});
	}

	webSocket.attachError(function () {
		if ([WEBSOCKET_STATUS.CONNECTING, WEBSOCKET_STATUS.CONNECTED].includes(internalModel.getProperty(WEBSOCKETSTATUS))) {
			showConnectionLostDialog();
		}
		internalModel.setProperty(WEBSOCKETSTATUS, WEBSOCKET_STATUS.ERROR);
	});

	webSocket.attachClose(function (evt: WebSocket$CloseEvent) {
		internalModel.setProperty(WEBSOCKETSTATUS, WEBSOCKET_STATUS.CLOSED);
		// RFC 6455 defines the status codes when closing an established connection :  https://datatracker.ietf.org/doc/html/rfc6455#section-7.4
		// status code 1000 means normal closure
		if ((evt.getParameter("code") as number | undefined) !== 1000) {
			showConnectionLostDialog();
		}
	});

	return true;
}

export function broadcastCollaborationMessage(
	action: Activity,
	content: string | undefined,
	internalModel: JSONModel,
	triggeredActionName?: string,
	refreshListBinding?: boolean,
	requestedProperties?: string
): void {
	if (isCollaborationConnected(internalModel)) {
		const webSocket = internalModel.getProperty(CONNECTION) as SapPcpWebSocket;

		webSocket.send("", {
			clientAction: action,
			clientContent: content,
			clientTriggeredActionName: triggeredActionName,
			clientRefreshListBinding: refreshListBinding,
			clientRequestedProperties: requestedProperties
		});

		if (action === Activity.Activate || action === Activity.Discard) {
			endCollaboration(internalModel);
		}
	}
}

export function endCollaboration(internalModel: JSONModel): void {
	const webSocket = internalModel.getProperty(CONNECTION) as SapPcpWebSocket | undefined;
	internalModel.setProperty(COLLABORATION, {});
	internalModel.setProperty(WEBSOCKETSTATUS, WEBSOCKET_STATUS.CLOSING);
	webSocket?.close();
}
