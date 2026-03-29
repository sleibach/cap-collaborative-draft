import type AppComponent from "sap/fe/core/AppComponent";
import Component from "sap/ui/core/Component";

import type Control from "sap/ui/core/Control";
import Library from "sap/ui/core/Lib";
import type Context from "sap/ui/model/odata/v4/Context";

// ADT Preview provides the user name and id for collaboration draft
declare global {
	interface Window {
		adt: {
			userName: string;
			userID: string;
		};
	}
}

export enum UserStatus {
	NotYetInvited = 0,
	NoChangesMade = 1,
	ChangesMade = 2,
	CurrentlyEditing = 3
}

export enum UserEditingState {
	NoChanges = "N",
	InProgress = "P"
}

export type User = {
	id: string;
	initials?: string;
	name: string;
	color?: string;
	transient?: boolean;
	status?: UserStatus;
	me?: boolean;
	initialName?: string;
};

// backend representation of a user according to collaboration draft spec
export type BackendUser = {
	UserID: string;
	UserAccessRole: string;
	UserEditingState?: UserEditingState;
	UserDescription?: string;
};

export type UserActivity = User & {
	key?: string;
};

export enum Activity {
	Join = "JOIN",
	JoinEcho = "JOINECHO",
	Leave = "LEAVE",
	Change = "CHANGE",
	Create = "CREATE",
	Delete = "DELETE",
	Action = "ACTION",
	Lock = "LOCK",
	LockEcho = "LOCKECHO",
	Activate = "ACTIVATE",
	Discard = "DISCARD",
	Unlock = "UNLOCK"
}

export type Message = {
	userDescription: string;
	userID: string;
	userAction: string;
	clientAction: string;
	clientTriggeredActionName?: string;
	clientRefreshListBinding?: string;
	clientRequestedProperties?: string;
	clientContent: string;
};

function formatInitials(fullName: string): string {
	// remove titles - those are the ones from S/4 to be checked if there are others
	const academicTitles = ["Dr.", "Prof.", "Prof. Dr.", "B.A.", "MBA", "Ph.D."];
	academicTitles.forEach(function (academicTitle) {
		fullName = fullName.replace(academicTitle, "");
	});

	let initials: string;
	const parts = fullName.trimStart().split(" ");

	if (parts.length > 1) {
		initials = (parts?.shift()?.charAt(0) || "") + parts.pop()?.charAt(0);
	} else {
		initials = fullName.substring(0, 2);
	}

	return initials.toUpperCase();
}

function getUserColor(UserID: string, activeUsers: User[], invitedUsers: User[]): string | undefined {
	// search if user is known
	const user = activeUsers.find((u) => u.id === UserID);
	if (user) {
		return user.color;
	} else {
		// search for next free color
		for (let i = 1; i <= 10; i++) {
			if (
				activeUsers.findIndex((u) => u.color === `Accent${i}`) === -1 &&
				invitedUsers.findIndex((u) => u.color === `Accent${i}`) === -1
			) {
				return `Accent${i}`;
			}
		}
		// this seems to be a popular object :) for now just return 10 for all.
		// for invited we should start from 1 again so the colors are different
		return "Accent10";
	}
}

// copied from CommonUtils. Due to a cycle dependency I can't use CommonUtils here.
// That's to be fixed. the discard popover thingy shouldn't be in the common utils at all
function getAppComponent(oControl: Control | Component): AppComponent {
	if (oControl.isA<AppComponent>("sap.fe.core.AppComponent")) {
		return oControl;
	}
	const oOwner = Component.getOwnerComponentFor(oControl);
	if (!oOwner) {
		return oControl as AppComponent;
	} else {
		return getAppComponent(oOwner);
	}
}

function getMe(appComponent: AppComponent): User {
	const shellServiceHelper = appComponent.getShellServices();
	let initials, id, name;
	if (shellServiceHelper?.hasUShell()) {
		initials = shellServiceHelper.getUserInitials();
		id = shellServiceHelper.getUser().getId();
		name = shellServiceHelper.getUser().getFullName();
	} else if (window.adt) {
		// check if we are in ADT preview, if so use the user provided by ADT
		id = window.adt.userID;
		name = window.adt.userName;
		initials = formatInitials(name);
	} else {
		throw "No Shell... No User";
	}

	return {
		initials: initials,
		id: id,
		name: getText("C_COLLABORATIONDRAFT_ME", name),
		initialName: name,
		color: "Accent6", //  same color as FLP...
		me: true,
		status: UserStatus.CurrentlyEditing
	};
}

export function getText(textId: string, ...args: string[]): string {
	const oResourceModel = Library.getResourceBundleFor("sap.fe.core")!;
	return oResourceModel.getText(textId, args);
}

export const CollaborationUtils = {
	formatInitials: formatInitials,
	getUserColor: getUserColor,
	getMe: getMe,
	getAppComponent: getAppComponent,
	getText: getText
};

export async function addSelf(context: Context): Promise<Context> {
	const model = context.getModel();
	const metaModel = model.getMetaModel();
	const entitySet = metaModel.getMetaPath(context.getPath());
	const shareActionName = metaModel.getObject(`${entitySet}@com.sap.vocabularies.Common.v1.DraftRoot/ShareAction`);
	const shareAction = model.bindContext(`${shareActionName}(...)`, context);
	shareAction.setParameter("Users", []);
	shareAction.setParameter("ShareAll", true);
	shareAction.setParameter("IsDeltaUpdate", true);
	shareAction.setParameter("If-Match", "*");
	return shareAction.invoke(undefined, true);
}

export async function shareObject(bindingContext: Context, users: BackendUser[] = [], groupId = "$auto.Workers"): Promise<Context> {
	const model = bindingContext.getModel();
	const metaModel = model.getMetaModel();
	const entitySet = metaModel.getMetaPath(bindingContext.getPath());
	const shareActionName = metaModel.getObject(`${entitySet}@com.sap.vocabularies.Common.v1.DraftRoot/ShareAction`);
	const shareAction = model.bindContext(`${shareActionName}(...)`, bindingContext);
	shareAction.setParameter("Users", users);
	shareAction.setParameter("ShareAll", true);
	return shareAction.invoke(groupId, true);
}

export function getActivityKeyFromPath(path: string): string {
	return path.substring(path.lastIndexOf("(") + 1, path.lastIndexOf(")"));
}

export const CollaborationFieldGroupPrefix = "_CollaborationDraft_";
