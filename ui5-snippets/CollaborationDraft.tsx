import type { EntitySet, Action as VocabularyAction } from "@sap-ux/vocabularies-types/Edm";
import type { EntitySetAnnotations_Common } from "@sap-ux/vocabularies-types/vocabularies/Common_Edm";
import type { DataField, DataFieldTypes } from "@sap-ux/vocabularies-types/vocabularies/UI";
import { UIAnnotationTypes } from "@sap-ux/vocabularies-types/vocabularies/UI";
import type { CompiledBindingToolkitExpression } from "sap/fe/base/BindingToolkit";
import { compileExpression, formatResult, getExpressionFromAnnotation } from "sap/fe/base/BindingToolkit";
import type { PropertiesOf } from "sap/fe/base/ClassSupport";
import { defineUI5Class, property } from "sap/fe/base/ClassSupport";
import type TemplateComponent from "sap/fe/core/TemplateComponent";
import BuildingBlock from "sap/fe/core/buildingBlocks/BuildingBlock";
import type { BackendUser, User } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import {
	CollaborationUtils,
	UserEditingState,
	UserStatus,
	shareObject
} from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import collaborationFormatter from "sap/fe/core/formatters/CollaborationFormatter";
import type { InternalModelContext } from "sap/fe/core/helpers/ModelHelper";
import ModelHelper from "sap/fe/core/helpers/ModelHelper";
import PromiseKeeper from "sap/fe/core/helpers/PromiseKeeper";
import { isAnnotationOfType, isPathAnnotationExpression } from "sap/fe/core/helpers/TypeGuards";
import type { DataModelObjectPath } from "sap/fe/core/templating/DataModelPathHelper";
import CommonHelper from "sap/fe/macros/CommonHelper";
import type { ValueHelpPayload } from "sap/fe/macros/internal/valuehelp/ValueListHelper";
import Avatar from "sap/m/Avatar";
import Button from "sap/m/Button";
import Dialog from "sap/m/Dialog";
import HBox from "sap/m/HBox";
import Label from "sap/m/Label";
import MessageStrip from "sap/m/MessageStrip";
import MessageToast from "sap/m/MessageToast";
import ObjectStatus from "sap/m/ObjectStatus";
import ResponsivePopover from "sap/m/ResponsivePopover";
import type Table from "sap/m/Table";
import Text from "sap/m/Text";
import VBox from "sap/m/VBox";
import type Event from "sap/ui/base/Event";
import type Control from "sap/ui/core/Control";
import Lib from "sap/ui/core/Lib";
import { ValueState } from "sap/ui/core/library";
import type { Field$ChangeEvent } from "sap/ui/mdc/Field";
import Field from "sap/ui/mdc/Field";
import ValueHelp from "sap/ui/mdc/ValueHelp";
import MDCDialog from "sap/ui/mdc/valuehelp/Dialog";
import MDCPopover from "sap/ui/mdc/valuehelp/Popover";
import MTable from "sap/ui/mdc/valuehelp/content/MTable";
import type JSONModel from "sap/ui/model/json/JSONModel";
import type Context from "sap/ui/model/odata/v4/Context";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type Integer from "sap/ui/model/type/Integer";
import type GridTableColumn from "sap/ui/table/Column";
import type GridTable from "sap/ui/table/Table";

const USERS_PARAMETERS = "Users";
const USER_ID_PARAMETER = "UserID";

@defineUI5Class("sap.fe.templates.ObjectPage.components.CollaborationDraft")
export default class CollaborationDraft extends BuildingBlock {
	@property({ type: "string", required: true })
	public contextPath!: string;

	@property({ type: "string" })
	public id?: string;

	private contextObject?: DataModelObjectPath<EntitySet>;

	private userDetailsPopover?: ResponsivePopover;

	private manageDialog?: Dialog;

	private manageDialogUserTable?: Table;

	private static GridTableControl: typeof GridTable;

	private static GridTableColumnControl: typeof GridTableColumn;

	private _controlLoaded?: PromiseKeeper<void>;

	constructor(props: PropertiesOf<CollaborationDraft>, others?: PropertiesOf<CollaborationDraft>) {
		super(props, others);
	}

	async onMetadataAvailable(_ownerComponent: TemplateComponent): Promise<void> {
		this._controlLoaded = new PromiseKeeper();
		if (CollaborationDraft.GridTableControl === undefined) {
			await Lib.load({ name: "sap.ui.table" });
			const { default: GridTableControl } = await import("sap/ui/table/Table");
			CollaborationDraft.GridTableControl = GridTableControl;
			const { default: GridTableColumnControl } = await import("sap/ui/table/Column");
			CollaborationDraft.GridTableColumnControl = GridTableColumnControl;
		}
		this.contextObject = this.getDataModelObjectPath(this.contextPath);
		this.content = this.createContent();
		this._controlLoaded.resolve();
	}

	/**
	 * Event handler to create and show the user details popover.
	 * @param event The event object
	 */
	showCollaborationUserDetails = (event: Event<{}, Control>): void => {
		const source = event.getSource();
		if (!this.userDetailsPopover) {
			this.userDetailsPopover = this.getUserDetailsPopover();
		}

		this.userDetailsPopover?.setBindingContext(source.getBindingContext("internal") as InternalModelContext, "internal");
		this.userDetailsPopover?.openBy(source);
	};

	/**
	 * Returns the user details popover.
	 * @returns The control tree
	 */
	getUserDetailsPopover(): ResponsivePopover {
		const userDetailsPopover = (
			<ResponsivePopover showHeader={false} class="sapUiContentPadding" placement="Bottom">
				<HBox>
					<Avatar initials="{internal>initials}" displaySize="S" backgroundColor="{internal>color}" />
					<VBox>
						<Label class="sapUiMediumMarginBegin" text="{internal>name}" />
						<Label class="sapUiMediumMarginBegin" text="{internal>id}" />
					</VBox>
				</HBox>
			</ResponsivePopover>
		);

		this.addDependent(userDetailsPopover);

		return userDetailsPopover;
	}

	/**
	 * Event handler to create and open the manage dialog.
	 *
	 */
	manageCollaboration = (): void => {
		if (!this.manageDialog) {
			this.manageDialog = this.getManageDialog();
		}

		this.readInvitedUsers();
		this.manageDialog?.open();
	};

	/**
	 * Returns the manage dialog used to invite further users.
	 * @returns The control tree
	 */
	getManageDialog(): Dialog {
		const manageDialog = (
			<Dialog
				title={this.getInvitationDialogTitleExpBinding()}
				horizontalScrolling="False"
				verticalScrolling="False"
				contentWidth="35em"
				stretch={CommonHelper.isDesktop() ? "false" : "true"}
			>
				{{
					beginButton: (
						<Button
							text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_DIALOG_CONFIRMATION")}
							press={this.inviteUser}
							type="Emphasized"
							enabled={{
								parts: [{ path: "internal>invitedUsers/length" }, { path: "internal>invitedUsers" }],
								formatter: this.formatInviteButton
							}}
						/>
					),
					endButton: (
						<Button
							text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_DIALOG_CANCEL")}
							press={this.closeManageDialog}
						/>
					),
					content: (
						<VBox class="sapUiSmallMargin">
							<VBox width="100%">
								<MessageStrip
									text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_MESSAGESTRIP")}
									type="Information"
									showIcon={true}
									showCloseButton={false}
									class="sapUiMediumMarginBottom"
								/>
							</VBox>
							<Label text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_INPUT_LABEL")} required={true} />
							{this.getManageDialogAddUserSection()}
							{this.getManageDialogUserTable()}
						</VBox>
					)
				}}
			</Dialog>
		);

		this.addDependent(manageDialog);
		manageDialog.bindElement({
			model: "internal",
			path: "collaboration"
		});

		return manageDialog;
	}

	/**
	 * Returning the table column with the list of invited users.
	 * @returns The control tree
	 */
	getManageDialogUserTableColumns(): GridTableColumn[] {
		return (
			<>
				<CollaborationDraft.GridTableColumnControl width={CommonHelper.isDesktop() ? "10%" : "3em"}>
					{{
						template: (
							<HBox alignItems="Center" justifyContent="SpaceBetween">
								<Avatar displaySize="XS" backgroundColor="{internal>color}" initials="{internal>initials}" />
							</HBox>
						)
					}}
				</CollaborationDraft.GridTableColumnControl>
				<CollaborationDraft.GridTableColumnControl width={CommonHelper.isDesktop() ? "35%" : "6em"}>
					{{
						label: <Text text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_TABLE_USER_COLUMN")} />,
						template: <Text text="{internal>name}" />
					}}
				</CollaborationDraft.GridTableColumnControl>
				<CollaborationDraft.GridTableColumnControl width={CommonHelper.isDesktop() ? "46%" : "9em"}>
					{{
						label: <Text text={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_TABLE_USER_STATUS_COLUMN")} />,
						template: (
							<ObjectStatus
								state={{ path: "internal>status", formatter: this.formatUserStatusColor }}
								text={{ path: "internal>status", formatter: this.formatUserStatus }}
							/>
						)
					}}
				</CollaborationDraft.GridTableColumnControl>
				<CollaborationDraft.GridTableColumnControl width={CommonHelper.isDesktop() ? "8%" : "3em"}>
					{{
						template: (
							<HBox>
								<Button
									icon="sap-icon://decline"
									type="Transparent"
									press={this.removeUser}
									visible="{= !!${internal>transient} }"
								/>
							</HBox>
						)
					}}
				</CollaborationDraft.GridTableColumnControl>
			</>
		);
	}

	/**
	 * Returns the table with the list of invited users.
	 * @returns The control tree
	 */
	getManageDialogUserTable(): Table | undefined {
		this.manageDialogUserTable = (
			<CollaborationDraft.GridTableControl
				width="100%"
				rows={{ path: "internal>invitedUsers" }}
				visibleRowCount={CommonHelper.isDesktop() ? "5" : "3"}
				visibleRowCountMode="Fixed"
				selectionMode="None"
			>
				{{
					columns: this.getManageDialogUserTableColumns()
				}}
			</CollaborationDraft.GridTableControl>
		);
		return this.manageDialogUserTable;
	}

	/**
	 * Returns the section on the dialog related to the user field.
	 * @returns The control tree
	 */
	getManageDialogAddUserSection(): HBox {
		return (
			<HBox class="sapUiMediumMarginBottom" width="100%">
				<Field
					value="{internal>UserID}"
					additionalValue="{internal>UserDescription}"
					display="DescriptionValue"
					width="20em"
					required={true}
					valueHelp="userValueHelp"
					placeholder={this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_INPUT_PLACEHOLDER")}
					change={this.addUserFieldChanged}
				>
					{{
						dependents: (
							<ValueHelp id="userValueHelp" delegate={this.getValueHelpDelegate()} validateInput={true}>
								{{
									typeahead: (
										<MDCPopover>
											<MTable caseSensitive="true" useAsValueHelp="false" />
										</MDCPopover>
									),
									dialog: <MDCDialog />
								}}
							</ValueHelp>
						)
					}}
				</Field>
			</HBox>
		);
	}

	/**
	 * Formatter to set the user status depending on the editing status.
	 * @param userStatus The editing status of the user
	 * @returns The user status
	 */
	formatUserStatus = (userStatus: UserStatus): string => {
		switch (userStatus) {
			case UserStatus.CurrentlyEditing:
				return this.getTranslatedText("C_COLLABORATIONDRAFT_USER_CURRENTLY_EDITING");
			case UserStatus.ChangesMade:
				return this.getTranslatedText("C_COLLABORATIONDRAFT_USER_CHANGES_MADE");
			case UserStatus.NoChangesMade:
				return this.getTranslatedText("C_COLLABORATIONDRAFT_USER_NO_CHANGES_MADE");
			case UserStatus.NotYetInvited:
			default:
				return this.getTranslatedText("C_COLLABORATIONDRAFT_USER_NOT_YET_INVITED");
		}
	};

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
	 * Formatter to enable the invite button depending on the invited users status.
	 * @param nbUsers Number of users
	 * @param invitedUsers List of the invited users
	 * @returns True or False
	 */
	formatInviteButton(nbUsers: Integer | undefined, invitedUsers: User[] | undefined): boolean {
		if (!nbUsers) {
			return false;
		}
		return !!invitedUsers?.some((user) => user.status === 0);
	}

	/**
	 * Add the added user to the list of invited users.
	 * @param userInput The user to be invited
	 * @param invitedUsers The users already invited
	 * @param newUser The user to be invited
	 */
	addUser(userInput: Field, invitedUsers: User[], newUser: User): void {
		const internalModelContext = userInput.getBindingContext("internal") as InternalModelContext;
		const activeUsers = (userInput.getModel("internal") as JSONModel).getProperty("/collaboration/activeUsers");
		newUser.name = newUser.name || newUser.id;
		newUser.initials = CollaborationUtils.formatInitials(newUser.name);
		newUser.color = CollaborationUtils.getUserColor(newUser.id, activeUsers, invitedUsers);
		newUser.transient = true;
		newUser.status = UserStatus.NotYetInvited;
		invitedUsers.push(newUser);
		internalModelContext.setProperty("invitedUsers", invitedUsers);
		internalModelContext.setProperty("UserID", "");
		internalModelContext.setProperty("UserDescription", "");
	}

	/**
	 * Sets the value state of the user field whenever changed.
	 * @param event The event object of the user input
	 * @returns Promise that is resolved once the value state was set.
	 */
	addUserFieldChanged = async (event: Field$ChangeEvent): Promise<void> => {
		const userInput = event.getSource();
		return event
			.getParameter("promise")
			?.then(
				function (this: CollaborationDraft, newUserId: string): void {
					const internalModelContext = userInput.getBindingContext("internal") as InternalModelContext;
					const invitedUsers: User[] = internalModelContext.getProperty("invitedUsers") || [];
					const newUser: User = {
						id: internalModelContext?.getProperty("UserID"),
						name: internalModelContext?.getProperty("UserDescription")
					};
					if (invitedUsers.findIndex((user) => user.id === newUserId) > -1) {
						userInput.setValueState("Error");
						userInput.setValueStateText(this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_USER_ERROR"));
					} else if (
						!(
							invitedUsers.findIndex((user) => user.id === newUser.id) > -1 ||
							(newUser.id === newUser.name && newUser.id === "")
						)
					) {
						this.addUser(userInput, invitedUsers, newUser);
						userInput.setValueState("None");
						userInput.setValueStateText("");
					}
				}.bind(this)
			)
			.catch(
				function (this: CollaborationDraft): void {
					userInput.setValueState("Warning");
					userInput.setValueStateText(this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_USER_NOT_FOUND"));
				}.bind(this)
			);
	};

	/**
	 * Event handler to remove a user from the list of invited user.
	 * @param event The event object of the remove button
	 */
	removeUser(event: Event<{}, Button>): void {
		const item = event.getSource();
		const internalModelContext = item?.getBindingContext("pageInternal");
		const deleteUserID = item?.getBindingContext("internal")?.getProperty("id");
		let invitedUsers: User[] = internalModelContext?.getProperty("collaboration/invitedUsers");
		invitedUsers = invitedUsers.filter((user) => user.id !== deleteUserID);
		internalModelContext?.setProperty("collaboration/invitedUsers", invitedUsers);
	}

	/**
	 * Call the share action to update the list of invited users.
	 * @param event The event object of the invite button
	 */
	inviteUser = async (event: Event<{}, Button>): Promise<void> => {
		const users: BackendUser[] = [],
			newlyInvitedUsers: string[] = [];
		const source = event.getSource();
		const bindingContext = source.getBindingContext() as Context;
		const contexts = (this.manageDialogUserTable?.getBinding("rows") as ODataListBinding).getContexts();
		contexts.forEach(function (context) {
			users.push({
				UserID: context.getProperty("id"),
				UserAccessRole: "O" // For now according to UX every user retrieves the owner role
			});
			if (context.getProperty("status") === UserStatus.NotYetInvited) {
				newlyInvitedUsers.push(context.getProperty("id"));
			}
		});

		try {
			// We request the number of invited users after the share action to see how many users were really invited
			const results = await Promise.all([shareObject(bindingContext, users), this.requestInvitedUsersInDraft()]);
			const newUsers: Context[] = [];
			results[1].forEach((invitedUser) => {
				if (newlyInvitedUsers.includes(invitedUser.getProperty("UserID"))) {
					newUsers.push(invitedUser);
				}
			});
			const messageHandler = this.getPageController()!.messageHandler;
			await messageHandler.showMessageDialog();

			switch (newUsers.length) {
				case 0:
					MessageToast.show(
						this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_SUCCESS_TOAST_NO_USER", [
							this.getSharedItemName(bindingContext)
						])
					);
					break;
				case 1:
					MessageToast.show(
						this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_SUCCESS_TOAST", [this.getSharedItemName(bindingContext)])
					);
					break;
				default:
					MessageToast.show(
						this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_SUCCESS_TOAST_PLURAL", [
							newUsers.length.toString(),
							this.getSharedItemName(bindingContext)
						])
					);
			}
		} catch {
			MessageToast.show(this.getTranslatedText("C_COLLABORATIONDRAFT_INVITATION_FAILED_TOAST"));
		}
		this.closeManageDialog();
	};

	/**
	 * Fetches the list of users that are already invited in the draft.
	 * @returns Promise with the list of user contexts.
	 */
	private async requestInvitedUsersInDraft(): Promise<Context[]> {
		const model = this.getModel();
		const parameters = {
			$select: "UserID,UserDescription,UserEditingState",
			$$groupId: "$auto.Workers"
		};
		const invitedUserList = model?.bindList(
			`${this.getBindingContext()?.getPath()}/DraftAdministrativeData/DraftAdministrativeUser`,
			undefined,
			[],
			[],
			parameters
		) as ODataListBinding;

		// for now we set a limit to 100. there shouldn't be more than a few
		return invitedUserList.requestContexts(0, 100);
	}

	/**
	 * Reads the currently invited user and store it in the internal model.
	 * @returns Promise that is resolved once the users are read.
	 */
	readInvitedUsers = async (): Promise<void> => {
		const internalModelContext = this.getBindingContext("internal") as InternalModelContext;

		try {
			const currentUserList = await this.requestInvitedUsersInDraft();
			const invitedUsers: User[] = [];
			const activeUsers = this.getModel("internal")?.getProperty("/collaboration/activeUsers") || [];
			const me = CollaborationUtils.getMe(this.getAppComponent()!);
			let userStatus: UserStatus;
			if (currentUserList.length > 0) {
				currentUserList.forEach((userContext) => {
					const userData = userContext.getObject() as BackendUser;
					const isMe: boolean = me?.id === userData.UserID;
					const isActive = activeUsers.find((u: User) => u.id === userData.UserID);
					let userDescription = userData.UserDescription || userData.UserID;
					const initials = CollaborationUtils.formatInitials(userDescription);
					userDescription = isMe ? `${CollaborationUtils.getText("C_COLLABORATIONDRAFT_ME", userDescription)}` : userDescription;
					if (isActive) {
						userStatus = UserStatus.CurrentlyEditing;
					} else if (userData.UserEditingState === UserEditingState.InProgress) {
						userStatus = UserStatus.ChangesMade;
					} else {
						userStatus = UserStatus.NoChangesMade;
					}

					const user: User = {
						id: userData.UserID,
						name: userDescription,
						status: userStatus,
						color: CollaborationUtils.getUserColor(userData.UserID, activeUsers, invitedUsers),
						initials: initials,
						me: isMe
					};
					invitedUsers.push(user);
				});
			} else {
				//not yet shared, just add me
				invitedUsers.push(me);
			}
			internalModelContext.setProperty("collaboration/UserID", "");
			internalModelContext.setProperty("collaboration/UserDescription", "");
			internalModelContext.setProperty("collaboration/invitedUsers", invitedUsers);
		} catch (e) {
			MessageToast.show(this.getTranslatedText("C_COLLABORATIONDRAFT_READING_USER_FAILED"));
		}
	};

	/**
	 * Get the name of the object to be shared.
	 * @param bindingContext The context of the page.
	 * @returns The name of the object to be shared.
	 */
	getSharedItemName(bindingContext: Context): string {
		const headerInfo = this.contextObject?.targetEntityType.annotations.UI?.HeaderInfo;
		let sharedItemName = "";
		const title = headerInfo?.Title;
		if (
			title &&
			isAnnotationOfType<DataFieldTypes>(title, [
				UIAnnotationTypes.DataField,
				UIAnnotationTypes.DataFieldWithAction,
				UIAnnotationTypes.DataFieldWithActionGroup,
				UIAnnotationTypes.DataFieldWithNavigationPath,
				UIAnnotationTypes.DataFieldWithIntentBasedNavigation,
				UIAnnotationTypes.DataFieldWithUrl,
				UIAnnotationTypes.DataFieldWithNavigationPath
			])
		) {
			sharedItemName = isPathAnnotationExpression(title.Value) ? bindingContext.getProperty(title.Value.path) : title.Value;
		}
		return sharedItemName || (headerInfo?.TypeName as unknown as string) || "";
	}

	/**
	 * Generates the delegate payload for the user field value help.
	 * @returns The value help delegate payload
	 */
	getValueHelpDelegate(): { name: string; payload: ValueHelpPayload } {
		// The non null assertion is safe here, because the action is only available if the annotation is present
		const actionName = (
			this.contextObject?.targetEntitySet!.annotations.Common as EntitySetAnnotations_Common
		).DraftRoot!.ShareAction!.toString();
		// We are also sure that the action exist
		const action = this.contextObject?.targetEntityType.resolvePath(actionName) as VocabularyAction;
		// By definition the action has a parameter with the name "Users"
		const userParameters = action.parameters.find((param) => param.name === USERS_PARAMETERS)!;

		return {
			name: "sap/fe/macros/valuehelp/ValueHelpDelegate",
			payload: {
				propertyPath: `/${userParameters.type}/${USER_ID_PARAMETER}`,
				qualifiers: {},
				valueHelpQualifier: "",
				isActionParameterDialog: true
			}
		};
	}

	/**
	 * Generate the expression binding of the Invitation dialog.
	 * @returns The dialog title binding expression
	 */
	getInvitationDialogTitleExpBinding(): CompiledBindingToolkitExpression {
		const headerInfo = this.contextObject?.targetEntityType.annotations.UI?.HeaderInfo;
		const title = getExpressionFromAnnotation((headerInfo?.Title as DataField | undefined)?.Value, [], "");
		const params = ["C_COLLABORATIONDRAFT_INVITATION_DIALOG", headerInfo?.TypeName.toString(), title];
		const titleExpression = formatResult(params, collaborationFormatter.getFormattedText);
		return compileExpression(titleExpression);
	}

	/**
	 * Event handler to close the manage dialog.
	 *
	 */
	closeManageDialog = (): void => {
		this.manageDialog?.close();
		this.manageDialog?.destroy();
		delete this.manageDialog;
	};

	/**
	 * Returns the invite button if there's a share action on root level.
	 * @returns The control tree
	 */
	getInviteButton(): HBox {
		if ((this.contextObject?.targetEntitySet?.annotations.Common as EntitySetAnnotations_Common)?.DraftRoot?.ShareAction) {
			return (
				<HBox visible="{ui>/isEditable}" alignItems="Center" justifyContent="Start">
					<Avatar backgroundColor="TileIcon" src="sap-icon://add-employee" displaySize="XS" press={this.manageCollaboration} />
				</HBox>
			);
		} else {
			return <HBox />;
		}
	}

	/**
	 * Returns the content of the collaboration draft building block.
	 * @returns The control tree
	 */
	createContent(): Control | undefined {
		if (this._getOwner()?.getMetaModel() && ModelHelper.isCollaborationDraftSupported(this._getOwner()!.getMetaModel())) {
			return (
				<HBox>
					<HBox
						items={{ path: "internal>/collaboration/activeUsers" }}
						class="sapUiTinyMarginBegin"
						visible="{= ${ui>/isEditable} &amp;&amp; ${internal>/collaboration/connected} }"
						alignItems="Center"
						justifyContent="Start"
					>
						<Avatar
							initials="{internal>initials}"
							displaySize="XS"
							backgroundColor="{internal>color}"
							press={this.showCollaborationUserDetails}
						/>
					</HBox>
					{this.getInviteButton()}
				</HBox>
			);
		}
	}
}
