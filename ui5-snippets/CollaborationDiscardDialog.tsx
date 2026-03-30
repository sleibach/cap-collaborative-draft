import type { FEView } from "sap/fe/core/BaseController";
import CommonUtils from "sap/fe/core/CommonUtils";
import type ResourceModel from "sap/fe/core/ResourceModel";
import type { BackendUser, User } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import { CollaborationUtils, UserEditingState, UserStatus } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import type { InternalModelContext } from "sap/fe/core/helpers/ModelHelper";
import ResourceModelHelper from "sap/fe/core/helpers/ResourceModelHelper";
import CommonHelper from "sap/fe/macros/CommonHelper";
import Avatar from "sap/m/Avatar";
import Button from "sap/m/Button";
import Dialog from "sap/m/Dialog";
import HBox from "sap/m/HBox";
import ObjectIdentifier from "sap/m/ObjectIdentifier";
import ObjectStatus from "sap/m/ObjectStatus";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import Lib from "sap/ui/core/Lib";
import { ValueState } from "sap/ui/core/library";
import type Context from "sap/ui/model/Context";
import Filter from "sap/ui/model/Filter";
import type GridTableColumn from "sap/ui/table/Column";
import type GridTable from "sap/ui/table/Table";

export default class CollaborationDiscard {
	public id?: string;

	private promiseResolve!: Function;

	public discardResourceModel!: ResourceModel;

	public containingView!: FEView;

	public manageDialog!: Dialog;

	private actionButton!: Button;

	private topText!: string;

	private bottomText!: string;

	private actionIsSave!: boolean;

	private static GridTableControl: typeof GridTable;

	private static GridTableColumnControl: typeof GridTableColumn;

	constructor(view: FEView, isSave: boolean) {
		this.actionIsSave = isSave;
		this.containingView = view;
		this.discardResourceModel = ResourceModelHelper.getResourceModel(view);
		if (isSave) {
			this.actionButton = this.getSaveButton();
			this.topText = this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_EDITING_DRAFT");
			this.bottomText = this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_SAVE_WARNING");
		} else {
			this.actionButton = this.getDiscardButton();
			this.topText = this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_CHANGES_DRAFT");
			this.bottomText = this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_DISCARD_WARNING");
		}
	}

	static async load(): Promise<typeof CollaborationDiscard> {
		if (CollaborationDiscard.GridTableControl === undefined) {
			await Lib.load({ name: "sap.ui.table" });
			const { default: GridTableControl } = await import("sap/ui/table/Table");
			CollaborationDiscard.GridTableControl = GridTableControl;
			const { default: GridTableColumnControl } = await import("sap/ui/table/Column");
			CollaborationDiscard.GridTableColumnControl = GridTableColumnControl;
		}
		return this;
	}

	/**
	 * Returns the manage dialog used to invite further users.
	 * @returns The control tree
	 */
	getManageDialog(): Dialog {
		this.manageDialog = (
			<Dialog
				title={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_TITLE")}
				state={ValueState.Warning}
				contentWidth="35em"
			>
				{{
					buttons: (
						<>
							keepDraftButton = {this.getKeepDraftButton()}
							confirmActionButton = {this.actionButton}
							cancelButton = {this.getCancelButton()}
						</>
					),
					content: (
						<VBox class="sapUiSmallMargin">
							<ObjectIdentifier class="sapUiSmallMarginBottom" text={this.topText}></ObjectIdentifier>

							{this.getManageDialogUserTable()}

							<Text class="sapUiSmallMarginTop" text={this.bottomText}></Text>
							<Text
								class="sapUiSmallMarginTop"
								text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_QUESTION")}
							></Text>
						</VBox>
					)
				}}
			</Dialog>
		);
		this.containingView.addDependent(this.manageDialog);
		this.manageDialog.bindElement({
			model: "internal",
			path: "collaboration"
		});
		return this.manageDialog;
	}

	/**
	 * Returns the table columns of invited users.
	 * @returns The control tree
	 */
	getManageDialogUserTableColumns(): GridTableColumn[] {
		return (
			<>
				<CollaborationDiscard.GridTableColumnControl width="3em">
					{{
						template: (
							<HBox alignItems="Center" justifyContent="SpaceBetween" width="100%">
								<Avatar displaySize="XS" backgroundColor="{internal>color}" initials="{internal>initials}" />
							</HBox>
						)
					}}
				</CollaborationDiscard.GridTableColumnControl>
				<CollaborationDiscard.GridTableColumnControl width="10rem">
					{{
						label: <Text text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_INVITATION_TABLE_USER_COLUMN")} />,
						template: <Text text="{internal>name}" />
					}}
				</CollaborationDiscard.GridTableColumnControl>
				<CollaborationDiscard.GridTableColumnControl width="14em">
					{{
						label: (
							<Text text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_INVITATION_TABLE_USER_STATUS_COLUMN")} />
						),
						template: (
							<ObjectStatus
								state={{ path: "internal>status", formatter: this.formatUserStatusColor }}
								text={{ path: "internal>status", formatter: this.formatUserStatus }}
							/>
						)
					}}
				</CollaborationDiscard.GridTableColumnControl>
			</>
		);
	}

	/**
	 * Returns the table with the list of invited users.
	 * @returns The control tree
	 */
	getManageDialogUserTable(): GridTable {
		const viewInternalModelContext = this.containingView.getBindingContext("internal") as InternalModelContext;
		const editingUsers = viewInternalModelContext.getProperty("collaboration/currentlyEditingUsers");
		let tableRowCount: number;
		if (CommonHelper.isDesktop()) {
			tableRowCount = editingUsers.length < 5 ? editingUsers.length : 5;
		} else {
			tableRowCount = editingUsers.length < 3 ? editingUsers.length : 3;
		}

		return (
			<CollaborationDiscard.GridTableControl
				width="100%"
				rows={{ path: "internal>currentlyEditingUsers" }}
				visibleRowCount={tableRowCount}
				visibleRowCountMode="Fixed"
				selectionMode="None"
			>
				{{
					columns: this.getManageDialogUserTableColumns()
				}}
			</CollaborationDiscard.GridTableControl>
		);
	}

	/**
	 * Formatter to set the user color depending on the editing status.
	 * @param userStatus The editing status of the user
	 * @returns The user status color
	 */
	formatUserStatusColor(userStatus: UserStatus): ValueState {
		switch (userStatus) {
			case UserStatus.CurrentlyEditing:
				return ValueState.Success;
			case UserStatus.ChangesMade:
				return ValueState.Warning;
			case UserStatus.NoChangesMade:
			case UserStatus.NotYetInvited:
			default:
				return ValueState.Information;
		}
	}

	/**
	 * Formatter to set the user status depending on the editing status.
	 * @param userStatus The editing status of the user
	 * @returns The user status
	 */
	formatUserStatus = (userStatus: UserStatus): string => {
		switch (userStatus) {
			case UserStatus.CurrentlyEditing:
				return this.discardResourceModel.getText("C_COLLABORATIONDRAFT_USER_CURRENTLY_EDITING");
			case UserStatus.ChangesMade:
				return this.discardResourceModel.getText("C_COLLABORATIONDRAFT_USER_CHANGES_MADE");
			case UserStatus.NoChangesMade:
				return this.discardResourceModel.getText("C_COLLABORATIONDRAFT_USER_NO_CHANGES_MADE");
			case UserStatus.NotYetInvited:
			default:
				return this.discardResourceModel.getText("C_COLLABORATIONDRAFT_USER_NOT_YET_INVITED");
		}
	};

	/**
	 * Reads the currently invited user and store it in the internal model.
	 * @returns Promise that is resolved once the users are read.
	 */
	async readInvitedUsers(): Promise<void> {
		const view = this.containingView;
		const model = view.getModel();
		const parameters = {
			$select: "UserID,UserDescription,UserEditingState"
		};
		const invitedUserList = model.bindList(
			"DraftAdministrativeData/DraftAdministrativeUser",
			view.getBindingContext() as Context,
			[],
			[],
			parameters
		);
		const me = CollaborationUtils.getMe(CommonUtils.getAppComponent(view));
		const internalModelContext = view.getBindingContext("internal") as InternalModelContext;
		if (me) {
			invitedUserList.filter(
				new Filter({
					path: "UserID",
					operator: "NE",
					value1: me.id
				})
			);
		}

		// for now we set a limit to 100. there shouldn't be more than a few
		const contexts = await invitedUserList.requestContexts(0, 100);

		const editingUsers: User[] = [];
		const activeUsers = view.getModel("internal").getProperty("/collaboration/activeUsers") || [];
		if (!contexts.length || contexts.length === 0) {
			internalModelContext.setProperty("collaboration/currentlyEditingUsers", []);
			return;
		}
		contexts.forEach((singleContext: Context) => {
			const userData = singleContext.getObject() as BackendUser;
			const user = this.createUser(userData, activeUsers);
			if (user) {
				user.color = CollaborationUtils.getUserColor(userData.UserID, activeUsers, editingUsers);
				editingUsers.push(user);
			}
		});

		const sortedUsers = this.sortUser(editingUsers);

		internalModelContext.setProperty("collaboration/currentlyEditingUsers", sortedUsers);
	}

	/**
	 * Reads the list of users currently editing the draft (except me) and stores it in the internal model.
	 */
	readCurrentUsers(): void {
		const view = this.containingView;
		const currentUsers: User[] = view.getModel("internal").getProperty("/collaboration/activeUsers") || [];
		const currentUsersWithoutMe = currentUsers
			.filter((user: User) => user.me !== true)
			.map((user: User) => {
				return { ...user, status: UserStatus.CurrentlyEditing };
			});
		const internalModelContext = view.getBindingContext("internal") as InternalModelContext;
		internalModelContext.setProperty("collaboration/currentlyEditingUsers", currentUsersWithoutMe);
	}

	/**
	 * This sorts the user according the Editing Status.
	 * CurrentlyEditing -> ChangesMade (Status 3 -> Status 2).
	 * @param editingUsers The array of Users to sort
	 * @returns The sorted array of Users
	 */
	sortUser(editingUsers: User[]): User[] {
		let sortedUsers = editingUsers;
		if (editingUsers.length > 1) {
			// We define our Users just above, Status is always defined
			sortedUsers = editingUsers.sort((userA: User, userB: User): number => {
				if (userA.status! < userB.status!) {
					return 1;
				} else if (userA.status! > userB.status!) {
					return -1;
				}
				return 0;
			});
		}
		return sortedUsers;
	}

	createUser(userData: BackendUser, activeUsers: User[]): User | undefined {
		let userStatus: UserStatus;
		const isActive = activeUsers.find((u: User) => u.id === userData.UserID);
		const userDescription = userData.UserDescription ?? userData.UserID;
		const initials = CollaborationUtils.formatInitials(userDescription);
		if (isActive) {
			userStatus = UserStatus.CurrentlyEditing;
		} else if (userData.UserEditingState === UserEditingState.InProgress) {
			userStatus = UserStatus.ChangesMade;
		} else {
			// This case is for user that are just invited, but didn't make any changes
			return undefined;
		}
		const user: User = {
			id: userData.UserID,
			name: userDescription,
			status: userStatus,
			initials: initials
		};
		return user;
	}

	/**
	 * Returns the Save button.
	 * @returns A button
	 */
	private getSaveButton(): Button {
		return <Button text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_SAVE")} press={this.saveManageDialog} />;
	}

	/**
	 * Event handler for the Save action of the manage dialog.
	 *
	 */
	saveManageDialog = (): void => {
		this.promiseResolve("save");
		this.manageDialog.close();
		this.manageDialog.destroy();
	};

	/**
	 * Returns the Discard button.
	 * @returns A button
	 */
	private getDiscardButton(): Button {
		return <Button text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_DISCARD")} press={this.discardManageDialog} />;
	}

	/**
	 * Event handler for the Discard action of the manage dialog.
	 *
	 */
	private discardManageDialog = (): void => {
		this.promiseResolve("discardConfirmed");
		this.manageDialog.close();
		this.manageDialog.destroy();
	};

	/**
	 * Returns the Cancel button.
	 * @returns A button
	 */
	private getCancelButton(): Button {
		return <Button text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_CANCEL")} press={this.cancelManageDialog} />;
	}

	/**
	 * Event handler for the Cancel action of the manage dialog.
	 *
	 */
	private cancelManageDialog = (): void => {
		this.promiseResolve("cancel");
		this.manageDialog.close();
		this.manageDialog.destroy();
	};

	/**
	 * Returns the Save button.
	 * @returns A button
	 */
	private getKeepDraftButton(): Button {
		return (
			<Button
				text={this.discardResourceModel.getText("C_COLLABORATIONDRAFT_DISCARD_KEEP_DRAFT")}
				press={this.keepDraftManageDialog}
				type="Emphasized"
			/>
		);
	}

	/**
	 * Event handler for the Keep Draft action of the manage dialog.
	 *
	 */
	private keepDraftManageDialog = (): void => {
		this.promiseResolve("keepDraft");
		this.manageDialog.close();
		this.manageDialog.destroy();
	};

	/**
	 * Reads the users, and opens the dialog to get the user input.
	 * @returns A string of the action selected by the user
	 */
	async getUserAction(): Promise<string> {
		if (this.actionIsSave) {
			// In case of a Save, we only show the list of users which are currenly editing the draft
			this.readCurrentUsers();
		} else {
			await this.readInvitedUsers();
		}

		return this.open();
	}

	/**
	 * Opens the discard draft from Discard/Cancel action.
	 * @returns A string of the action selected by the user
	 */
	public async open(): Promise<string> {
		await CollaborationDiscard.load();
		const internalModelContext = this.containingView.getBindingContext("internal") as InternalModelContext;
		const editingUsers = internalModelContext.getProperty("collaboration/currentlyEditingUsers");
		if (editingUsers.length === 0) {
			return this.actionIsSave ? "save" : "discard";
		}
		// We create the dialog after reading the users
		this.manageDialog = this.getManageDialog();
		// We set up the binding context of the Dialog
		(this.manageDialog.getBindingContext("internal") as InternalModelContext).setProperty("currentlyEditingUsers", editingUsers);
		this.manageDialog.open();

		return new Promise((resolve) => {
			this.promiseResolve = resolve;
		});
	}
}
