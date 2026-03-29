import type { Property } from "@sap-ux/vocabularies-types";
import Log from "sap/base/Log";
import type { FEView } from "sap/fe/core/BaseController";
import CommonUtils from "sap/fe/core/CommonUtils";
import type { FieldSideEffectDictionary } from "sap/fe/core/controllerextensions/SideEffects";
import {
	broadcastCollaborationMessage,
	endCollaboration,
	initializeCollaboration,
	isCollaborationConnected
} from "sap/fe/core/controllerextensions/collaboration/ActivityBase";
import type { Message, User, UserActivity } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import { Activity, CollaborationUtils, getActivityKeyFromPath } from "sap/fe/core/controllerextensions/collaboration/CollaborationCommon";
import * as MetaModelConverter from "sap/fe/core/converters/MetaModelConverter";
import ModelHelper from "sap/fe/core/helpers/ModelHelper";
import InstanceManager from "sap/m/InstanceManager";
import MessageBox from "sap/m/MessageBox";
import type UI5Element from "sap/ui/core/Element";
import type View from "sap/ui/core/mvc/View";
import Service from "sap/ui/core/service/Service";
import ServiceFactory from "sap/ui/core/service/ServiceFactory";
import type JSONModel from "sap/ui/model/json/JSONModel";
import type Context from "sap/ui/model/odata/v4/Context";
import type ODataListBinding from "sap/ui/model/odata/v4/ODataListBinding";
import type { ServiceContext } from "types/metamodel_types";

const MYACTIVITIES = "/collaboration/myActivities";
const ACTIVEUSERS = "/collaboration/activeUsers";
const ACTIVITIES = "/collaboration/activities";
const ASYNCMESSAGESQUEUE = "/collaboration/asyncMsgQueue";
const RETAINEDASYNCMESSAGES = "/collaboration/retainedMessages";
const ASYNCMESSAGESTIMERID = "/collaboration/asyncMsgTimerId";
const SYNCGROUPID = "$auto.sync";

const DELAYONFOCUS = 500; // 500ms delay for async LOCK/UNLOCK messages

type AsyncMessage = {
	path: string;
	action: Activity.Unlock | Activity.Lock;
};

export class CollaborativeDraftService extends Service<CollaborativeDraftServiceFactory> {
	initPromise!: Promise<CollaborativeDraftService>;

	/**
	 * Checks if a given path is locked by the current user.
	 * @param activityModel
	 * @param activityPath
	 * @returns True if the path is locked
	 */
	checkPathForLock(activityModel: JSONModel, activityPath: string): boolean {
		const myActivities: string[] | undefined | null = activityModel.getProperty(MYACTIVITIES);
		if (!myActivities) {
			return false;
		} else {
			return myActivities.includes(activityPath);
		}
	}

	/**
	 * Sets a path as locked for the current user.
	 * @param activityModel
	 * @param activityPath
	 */
	setLock(activityModel: JSONModel, activityPath: string): void {
		const myActivities: string[] = activityModel.getProperty(MYACTIVITIES) ?? [];
		if (!myActivities.includes(activityPath)) {
			myActivities.push(activityPath);
		}

		activityModel.setProperty(MYACTIVITIES, myActivities);
	}

	/**
	 * Removes the lock for a given path.
	 * @param activityModel
	 * @param activityPaths
	 * @returns True if the path was previously locked
	 */
	removeLock(activityModel: JSONModel, activityPaths: string | string[] | undefined): boolean {
		const myActivities: string[] | undefined | null = activityModel.getProperty(MYACTIVITIES);
		if (!myActivities || activityPaths === undefined) {
			return false;
		}

		const pathsToRemove = Array.isArray(activityPaths) ? activityPaths : [activityPaths];
		const myNewActivities = myActivities.filter((activity) => {
			return !pathsToRemove.includes(activity);
		});
		activityModel.setProperty(MYACTIVITIES, myNewActivities);

		return myNewActivities.length !== myActivities.length;
	}

	/**
	 * Returns all locked paths for the current user.
	 * @param activityModel
	 * @returns Concatenated paths for all locked properties
	 */
	getLockedProperties(activityModel: JSONModel): string | undefined {
		const myActivities: string[] | undefined | null = activityModel.getProperty(MYACTIVITIES);
		if (!myActivities) {
			return undefined;
		} else {
			return myActivities.join("|");
		}
	}

	/**
	 * Updates all current locks by changing a context path.
	 * This is called when activating a context, where the initial locks were using the transient path
	 * and need to be updated with the actual path.
	 * @param element
	 * @param oldContextPath
	 * @param newContextPath
	 */
	updateLocksForContextPath(element: UI5Element, oldContextPath: string, newContextPath: string): void {
		if (!this.isConnected(element)) {
			return;
		}

		const internalModel = element.getModel("internal") as JSONModel;

		// Replace paths in pending async messages
		const currentQueue: AsyncMessage[] = internalModel.getProperty(ASYNCMESSAGESQUEUE);
		currentQueue.forEach((queueItem) => {
			if (queueItem.path.startsWith(oldContextPath)) {
				queueItem.path = queueItem.path.replace(oldContextPath, newContextPath);
			}
		});

		// Replace paths in existing locks (and broadcast the corresponding message if necessary)
		const myActivities: string[] | undefined | null = internalModel.getProperty(MYACTIVITIES);
		if (myActivities) {
			const changedActivities: string[] = [];
			const unchangedActivities: string[] = [];
			myActivities.forEach((lockedPath) => {
				if (lockedPath.startsWith(oldContextPath)) {
					// Replace the path in the list of locks, and store this path for sending a new LOCK message
					const newlockedPath = lockedPath.replace(oldContextPath, newContextPath);
					changedActivities.push(newlockedPath);
				} else {
					unchangedActivities.push(lockedPath);
				}
			});

			internalModel.setProperty(MYACTIVITIES, unchangedActivities);
			if (changedActivities.length !== 0) {
				this.send(element, { action: Activity.Lock, content: changedActivities });
			}
		}
	}

	/**
	 * Resets the timer for sending asynchronous collaboration messages.
	 * @param internalModel
	 */
	resetAsyncMessagesTimer(internalModel: JSONModel): void {
		let timerId = internalModel.getProperty(ASYNCMESSAGESTIMERID);
		if (timerId !== undefined) {
			clearTimeout(timerId);
		}

		timerId = setTimeout(() => {
			const queue: AsyncMessage[] | undefined = internalModel.getProperty(ASYNCMESSAGESQUEUE);
			const newQueue: AsyncMessage[] = [];
			const pathsToRetain: string[] = internalModel.getProperty(RETAINEDASYNCMESSAGES) ?? [];

			if (!queue) {
				return;
			}

			queue.forEach((item) => {
				if (pathsToRetain.includes(item.path)) {
					newQueue.push(item);
				} else {
					this.doSend(internalModel, item.action, item.path);
				}
			});

			internalModel.setProperty(ASYNCMESSAGESQUEUE, newQueue);
			internalModel.setProperty(ASYNCMESSAGESTIMERID, undefined);

			if (newQueue.length) {
				// If some messages are still pending, reschedule a new timer
				this.resetAsyncMessagesTimer(internalModel);
			}
		}, DELAYONFOCUS);

		internalModel.setProperty(ASYNCMESSAGESTIMERID, timerId);
	}

	/**
	 * Mark some paths as being retained, i.e. async messages for these paths won't be sent but kept until they're released.
	 * This applies to existing async messages in the queue, but also to future messages.
	 * @param element
	 * @param activityPaths The paths to be retained
	 */
	retainAsyncMessages(element: UI5Element, activityPaths: string | string[]): void {
		const internalModel = element.getModel("internal") as JSONModel;
		const additionalPathsToRetain = Array.isArray(activityPaths) ? activityPaths : [activityPaths];

		const retainedPaths: string[] = internalModel.getProperty(RETAINEDASYNCMESSAGES);
		additionalPathsToRetain.forEach((path) => {
			if (!retainedPaths.includes(path)) {
				retainedPaths.push(path);
			}
		});
	}

	/**
	 * Release async messages for some paths that were previously retained.
	 * The corresponding messages are not sent immediately, but the next time the async timer wakes up.
	 * @param element
	 * @param activityPaths The paths to be released
	 */
	releaseAsyncMessages(element: UI5Element, activityPaths: string | string[]): void {
		const internalModel = element.getModel("internal") as JSONModel;
		const pathsToRetain: string[] = internalModel.getProperty(RETAINEDASYNCMESSAGES);
		const pathsToRelease = Array.isArray(activityPaths) ? activityPaths : [activityPaths];

		internalModel.setProperty(
			RETAINEDASYNCMESSAGES,
			pathsToRetain.filter((retainedPath) => {
				return !pathsToRelease.includes(retainedPath);
			})
		);
	}

	/**
	 * Checks if a collaboration session is currently open.
	 * @param element
	 * @returns True if a collaboration session is currently open.
	 */
	isConnected(element: UI5Element): boolean {
		const internalModel = element.getModel("internal") as JSONModel;
		return isCollaborationConnected(internalModel);
	}

	/**
	 * Sends a collaboration message to other connected users.
	 * @param element
	 * @param message
	 * @param message.action
	 * @param message.content
	 * @param message.triggeredActionName
	 * @param message.refreshListBinding
	 * @param message.actionRequestedProperties
	 */
	public send(
		element: UI5Element,
		message: {
			action: Activity;
			content: string | string[] | undefined;
			triggeredActionName?: string;
			refreshListBinding?: boolean;
			actionRequestedProperties?: string[];
		}
	): void {
		if (this.isConnected(element)) {
			const internalModel = element.getModel("internal") as JSONModel;
			if (message.action === Activity.Lock || message.action === Activity.Unlock) {
				// Lock-related events are always sent with some delay
				this.doSendAsync(internalModel, message.action, message.content);
			} else {
				this.doSend(
					internalModel,
					message.action,
					message.content,
					message.triggeredActionName,
					message.refreshListBinding,
					message.actionRequestedProperties
				);
			}
		}
	}

	/**
	 * Internal function to send a collaboration message immediately.
	 * @param internalModel
	 * @param action
	 * @param content
	 * @param triggeredActionName
	 * @param refreshListBinding
	 * @param actionRequestedProperties
	 */
	doSend(
		internalModel: JSONModel,
		action: Activity,
		content: string | string[] | undefined,
		triggeredActionName?: string,
		refreshListBinding?: boolean,
		actionRequestedProperties?: string[]
	): void {
		const clientContent = (Array.isArray(content) ? content.join("|") : content) ?? "";
		const requestedProperties = actionRequestedProperties?.join("|");
		if (action === Activity.Lock) {
			const pathForLock = (Array.isArray(content) ? content[0] : content) ?? "";
			// To avoid unnecessary traffic we keep track of lock changes and send it only once
			if (this.checkPathForLock(internalModel, pathForLock)) {
				return;
			} else {
				this.setLock(internalModel, pathForLock);
			}
		} else if (action === Activity.Unlock) {
			const removed = this.removeLock(internalModel, content);
			// No need to send an Unlock message if it was not already locked
			if (!removed) {
				return;
			}
		}

		broadcastCollaborationMessage(action, clientContent, internalModel, triggeredActionName, refreshListBinding, requestedProperties);
	}

	/**
	 * Internal function to send a collaboration message asynchronously.
	 * @param internalModel
	 * @param action
	 * @param content
	 */
	doSendAsync(internalModel: JSONModel, action: Activity.Lock | Activity.Unlock, content: string | string[] | undefined): void {
		if (content === undefined) {
			return;
		}
		const currentQueue: AsyncMessage[] = internalModel.getProperty(ASYNCMESSAGESQUEUE);
		const pathsToAdd = Array.isArray(content) ? content : [content];
		// Remove existing items in the queue for the paths that will be added
		const newQueue = currentQueue.filter((item) => {
			return !pathsToAdd.includes(item.path);
		});
		pathsToAdd.forEach((path) => {
			newQueue.push({ path, action });
		});
		internalModel.setProperty(ASYNCMESSAGESQUEUE, newQueue);
		this.resetAsyncMessagesTimer(internalModel);
	}

	isCollaborationEnabled(view: View): boolean {
		const bindingContext = view?.getBindingContext && (view.getBindingContext() as Context);
		return !!(bindingContext && ModelHelper.isCollaborationDraftSupported(bindingContext.getModel().getMetaModel()));
	}

	/**
	 * Function to establish a connection with a collaborative draft service.
	 * @param draftRootContext The draft root context
	 * @param view  The view that is used to connect the websocket
	 * @returns Promise
	 */
	async connect(draftRootContext: Context, view: FEView): Promise<void> {
		const internalModel = view.getModel("internal");
		const me = CollaborationUtils.getMe(CommonUtils.getAppComponent(view));

		// Retrieving ME from shell service
		if (!me) {
			// no me = no shell = not sure what to do
			return;
		}

		const sDraftUUID = await draftRootContext.requestProperty("DraftAdministrativeData/DraftUUID");
		if (!sDraftUUID) {
			return;
		}

		const initialized = initializeCollaboration(
			me,
			sDraftUUID,
			internalModel,
			(message: Message) => {
				this.messageReceive(message, view);
			},
			view
		);

		if (initialized) {
			internalModel.setProperty(MYACTIVITIES, []);
			internalModel.setProperty(ASYNCMESSAGESQUEUE, []);
			internalModel.setProperty(RETAINEDASYNCMESSAGES, []);
		}
	}

	/**
	 * Function to close a connection with a collaborative draft service.
	 * @param view Current View
	 */
	disconnect(view: FEView): void {
		const internalModel = view.getModel("internal");
		endCollaboration(internalModel);
	}

	/**
	 * Function to update internal model when a user joins the draft.
	 * @param activeUsers List of connected users
	 * @param internalModel Internal model
	 * @param sender User sending the JOIN or JOINECHO message
	 * @param message The message
	 * @param view Current View
	 */
	userJoinDraft(activeUsers: User[], internalModel: JSONModel, sender: User, message: Message, view: FEView): void {
		if (activeUsers.findIndex((user) => user.id === sender.id) === -1) {
			activeUsers.unshift(sender);
			internalModel.setProperty(ACTIVEUSERS, activeUsers);
		}

		if (message.userAction === Activity.Join) {
			// we echo our existence to the newly entered user and also send the current activity if there is any
			broadcastCollaborationMessage(Activity.JoinEcho, this.getLockedProperties(internalModel), internalModel);
		}

		if (message.userAction === Activity.JoinEcho) {
			if (message.clientContent) {
				// another user was already typing therefore I want to see his activity immediately. Calling me again as a live change
				message.userAction = Activity.LockEcho;
				this.messageReceive(message, view);
			}
		}
	}

	/**
	 * Function to update internal model when a user leaves the draft.
	 * @param activeUsers List of connected users
	 * @param internalModel Internal model
	 * @param sender User sending the JOIN or JOINECHO message
	 */
	userLeaveDraft(activeUsers: User[], internalModel: JSONModel, sender: User): void {
		// Removing the active user. Not removing "me" if I had the screen open in another session
		activeUsers = activeUsers.filter((user) => user.id !== sender.id || user.me);
		internalModel.setProperty(ACTIVEUSERS, activeUsers);
		const allActivities = internalModel.getProperty(ACTIVITIES) || {};
		const removeUserActivities = function (bag: Record<string, unknown> | UserActivity[]): Record<string, unknown> | UserActivity[] {
			if (Array.isArray(bag)) {
				return bag.filter((activity) => activity.id !== sender.id);
			} else {
				for (const p in bag) {
					bag[p] = removeUserActivities(bag[p] as Record<string, unknown> | UserActivity[]);
				}
				return bag;
			}
		};
		removeUserActivities(allActivities);
		internalModel.setProperty(ACTIVITIES, allActivities);
	}

	/**
	 * Callback when a message is received from the websocket.
	 * @param message The message received
	 * @param view The view that was used initially when connecting the websocket
	 */
	messageReceive(message: Message, view: FEView): void {
		const internalModel = view.getModel("internal");
		const activeUsers: User[] = internalModel.getProperty(ACTIVEUSERS);
		let activities: UserActivity[];
		let activityKey: string;
		const metaPath = this.calculateMetaPath(view, message.clientContent);
		message.userAction = message.userAction || message.clientAction;

		const sender: User = {
			id: message.userID,
			name: message.userDescription,
			initials: CollaborationUtils.formatInitials(message.userDescription),
			color: CollaborationUtils.getUserColor(message.userID, activeUsers, [])
		};

		let mactivity: UserActivity = sender;

		// eslint-disable-next-line default-case
		switch (message.userAction) {
			case Activity.Join:
			case Activity.JoinEcho:
				this.userJoinDraft(activeUsers, internalModel, sender, message, view);
				break;

			case Activity.Leave:
				this.userLeaveDraft(activeUsers, internalModel, sender);
				break;

			case Activity.Change:
				this.updateOnChange(view, message);
				break;

			case Activity.Create:
				// For create we actually just need to refresh the table
				this.updateOnCreate(view, message);
				break;

			case Activity.Delete:
				// For now also refresh the page but in case of deletion we need to inform the user
				this.updateOnDelete(view, message);
				break;

			case Activity.Activate:
				this.draftClosedByOtherUser(
					view,
					message.clientContent,
					CollaborationUtils.getText("C_COLLABORATIONDRAFT_ACTIVATE", sender.name),
					message.userAction
				);
				break;

			case Activity.Discard:
				this.draftClosedByOtherUser(
					view,
					message.clientContent,
					CollaborationUtils.getText("C_COLLABORATIONDRAFT_DISCARD", sender.name),
					message.userAction
				);
				break;

			case Activity.Action:
				this.updateOnAction(view, message);
				break;

			case Activity.Lock:
			case Activity.LockEcho:
				mactivity = sender;
				mactivity.key = getActivityKeyFromPath(message.clientContent);

				// stupid JSON model...
				let initJSONModel = "";
				const parts = metaPath.split("/");
				for (let i = 1; i < parts.length - 1; i++) {
					initJSONModel += `/${parts[i]}`;
					if (!internalModel.getProperty(ACTIVITIES + initJSONModel)) {
						internalModel.setProperty(ACTIVITIES + initJSONModel, {});
					}
				}

				activities = internalModel.getProperty(ACTIVITIES + metaPath);
				activities = activities?.slice ? activities.slice() : [];
				activities.push(mactivity);
				internalModel.setProperty(ACTIVITIES + metaPath, activities);
				if (message.userAction === Activity.LockEcho && this.checkPathForLock(internalModel, message.clientContent)) {
					// The current user has locked this path right after connection, before knowing it was already locked by someone else
					// --> remove the current lock
					this.doSend(internalModel, Activity.Unlock, message.clientContent);
				}
				break;

			case Activity.Unlock:
				// The user did a change but reverted it, therefore unblock the control
				activities = internalModel.getProperty(ACTIVITIES + metaPath);
				activityKey = getActivityKeyFromPath(message.clientContent);
				internalModel.setProperty(ACTIVITIES + metaPath, activities?.filter((a) => a.key !== activityKey));
				break;
		}
	}

	/**
	 * Displays a message that the current draft was closed be another user, and navigates back to a proper view.
	 * @param view The view that was used initially when connecting the websocket
	 * @param path The path of the context to navigate to
	 * @param messageText The message to display
	 * @param userAction The user action
	 */
	draftClosedByOtherUser(view: FEView, path: string, messageText: string, userAction: string): void {
		this.disconnect(view);
		MessageBox.information(messageText, {
			onClose: async () => {
				try {
					await view.getBindingContext().getBinding().resetChanges();
					if (InstanceManager.hasOpenDialog()) {
						// Close all open dialogs before navigating
						InstanceManager.closeAllDialogs(() => {});
					}
					this.navigate(path, view, userAction);
					return;
				} catch (error) {
					Log.error("Pending Changes could not be reset - still navigating to active instance");
					this.navigate(path, view, userAction);
				}
			}
		});
	}

	/**
	 * Updates data when a CHANGE message has been received.
	 * @param view The view that was used initially when connecting the websocket
	 * @param message The message received from the websocket
	 */
	updateOnChange(view: FEView, message: Message): void {
		const updatedObjectsPaths = message.clientContent.split("|");

		const currentPage = this.getCurrentPage(view);
		const currentContext = currentPage.getBindingContext();
		const requestPromises = updatedObjectsPaths.map(async (path) => this.applyUpdatesForChange(view, path));

		// Simulate any change so the edit flow shows the draft indicator and sets the page to dirty
		currentPage.getController().editFlow.updateDocument(currentContext, Promise.all(requestPromises));
	}

	/**
	 * Updates data corresponding to a path.
	 * @param view The view that was used initially when connecting the websocket
	 * @param propertyPathForUpdate Absolute path to the updated property
	 * @returns A promise resolved when the data and its related side effects have been received
	 */
	async applyUpdatesForChange(view: FEView, propertyPathForUpdate: string): Promise<void> {
		const metaModel = view.getModel().getMetaModel();
		const metaContext = metaModel.getMetaContext(propertyPathForUpdate);
		const dataModelObject = MetaModelConverter.getInvolvedDataModelObjects<Property>(metaContext);
		const targetContextPath = propertyPathForUpdate.substring(0, propertyPathForUpdate.lastIndexOf("/")); // Remove property name
		const targetContext = this.findContextForUpdate(view, targetContextPath);
		const parentCollectionPath = targetContextPath.substring(0, targetContextPath.lastIndexOf("("));
		const parentContextPath = parentCollectionPath.substring(0, parentCollectionPath.lastIndexOf("/"));
		const parentContext = parentContextPath ? this.findContextForUpdate(view, parentContextPath) : undefined;

		if (!targetContext && !parentContext) {
			return; // No context for update
		}

		try {
			const sideEffectsPromises: Promise<unknown>[] = [];
			const sideEffectsService = CollaborationUtils.getAppComponent(view).getSideEffectsService();

			if (targetContext) {
				// We have a target context, so we can retrieve the updated property
				const targetMetaPath = metaModel.getMetaPath(targetContext.getPath());
				const relativeMetaPathForUpdate = metaModel.getMetaPath(propertyPathForUpdate).replace(targetMetaPath, "").slice(1);
				sideEffectsPromises.push(sideEffectsService.requestSideEffects([relativeMetaPathForUpdate], targetContext, SYNCGROUPID));
			}

			// Get the fieldGroupIds corresponding to pathForUpdate
			const fieldGroupIds = sideEffectsService.computeFieldGroupIds(
				dataModelObject.targetEntityType.fullyQualifiedName,
				dataModelObject.targetObject!.fullyQualifiedName
			);

			// Execute the side effects for the fieldGroupIds
			if (fieldGroupIds.length) {
				const pageController = view.getController();
				const sideEffectsMapForFieldGroup = pageController._sideEffects.getSideEffectsMapForFieldGroups(
					fieldGroupIds,
					targetContext || parentContext
				) as FieldSideEffectDictionary;
				Object.keys(sideEffectsMapForFieldGroup).forEach((sideEffectName) => {
					const sideEffect = sideEffectsMapForFieldGroup[sideEffectName];
					sideEffectsPromises.push(
						pageController._sideEffects.requestSideEffects(
							sideEffect.sideEffects,
							sideEffect.context,
							SYNCGROUPID,
							undefined,
							true
						)
					);
				});
			}

			await Promise.all(sideEffectsPromises);
		} catch (err) {
			Log.error("Failed to update data after change:" + err);
			throw err;
		}
	}

	/**
	 * Updates data when a DELETE message has been received.
	 * @param view The view that was used initially when connecting the websocket
	 * @param message The message received from the websocket
	 */
	updateOnDelete(view: View, message: Message): void {
		const currentPage = this.getCurrentPage(view);
		const currentContext = currentPage.getBindingContext();
		const currentPath = currentContext.getPath();

		const deletedObjectPaths = message.clientContent.split("|");

		// check if user currently displays a deleted object or one of its descendants
		const deletedPathInUse = deletedObjectPaths.find((deletedPath) => currentPath.startsWith(deletedPath));
		if (deletedPathInUse) {
			// any other user deleted the object I'm currently looking at. Inform the user we will navigate to root now
			MessageBox.information(CollaborationUtils.getText("C_COLLABORATIONDRAFT_DELETE", message.userDescription), {
				onClose: () => {
					// We retrieve the deleted context as a keep-alive, and disable its keepalive status,
					// so that it is properly destroyed when refreshing data
					const targetContext = currentContext.getModel().getKeepAliveContext(deletedPathInUse);
					targetContext.setKeepAlive(false);
					const requestPromise = this.applyUpdatesForCollection(view, deletedObjectPaths[0]);
					currentPage.getController().editFlow.updateDocument(currentPage.getBindingContext(), requestPromise);
					currentPage.getController()._routing.navigateBackFromContext(targetContext);
				}
			});
		} else {
			const requestPromise = this.applyUpdatesForCollection(view, deletedObjectPaths[0]);
			currentPage.getController().editFlow.updateDocument(currentPage.getBindingContext(), requestPromise);
		}
	}

	/**
	 * Updates data when a CREATE message has been received.
	 * @param view The view that was used initially when connecting the websocket
	 * @param message The message received from the websocket
	 */
	updateOnCreate(view: View, message: Message): void {
		const currentPage = this.getCurrentPage(view);
		const createdObjectPaths = message.clientContent.split("|");

		const requestPromise = this.applyUpdatesForCollection(view, createdObjectPaths[0]);
		// Simulate a change so the edit flow shows the draft indicator and sets the page to dirty
		currentPage.getController().editFlow.updateDocument(currentPage.getBindingContext(), requestPromise);
	}

	/**
	 * Updates data in a collection.
	 * @param view The view that was used initially when connecting the websocket
	 * @param pathInCollection A path to an entity in the collection
	 */
	async applyUpdatesForCollection(view: View, pathInCollection: string): Promise<void> {
		const appComponent = CollaborationUtils.getAppComponent(view);
		const parentPath = pathInCollection.substring(0, pathInCollection.lastIndexOf("/"));
		const parentContext = this.findContextForUpdate(view, parentPath);

		if (parentContext) {
			try {
				const sideEffectsPromises: Promise<unknown>[] = [];

				const metaModel = parentContext.getModel().getMetaModel();
				const metaPathForUpdate = metaModel.getMetaPath(pathInCollection);
				const parentMetaPath = metaModel.getMetaPath(parentContext.getPath());
				const relativePath = metaPathForUpdate.replace(`${parentMetaPath}/`, "");

				// Reload the collection
				const sideEffectsService = appComponent.getSideEffectsService();
				sideEffectsPromises.push(sideEffectsService.requestSideEffects([relativePath], parentContext, SYNCGROUPID));

				// Request the side effects for the collection
				sideEffectsPromises.push(
					sideEffectsService.requestSideEffectsForNavigationProperty(relativePath, parentContext, SYNCGROUPID, true)
				);

				await Promise.all(sideEffectsPromises);
			} catch (err) {
				Log.error("Failed to update data after collection update:" + err);
			}
		}
	}

	/**
	 * Updates data when a ACTION message has been received.
	 * @param view The view that was used initially when connecting the websocket
	 * @param message The message received from the websocket
	 */
	updateOnAction(view: FEView, message: Message): void {
		const currentPage = this.getCurrentPage(view);
		const pathsForAction = message.clientContent.split("|");
		const actionName = message.clientTriggeredActionName || "";
		const requestedProperties = message.clientRequestedProperties?.split("|");
		const refreshListBinding = message.clientRefreshListBinding === "true";

		let requestPromises: Promise<void>[] = [];

		if (refreshListBinding) {
			requestPromises.push(this.applyUpdatesForCollection(view, pathsForAction[0]));
		} else {
			requestPromises = pathsForAction.map(async (path) => this.requestUpdateForAction(view, path, actionName, requestedProperties));
		}

		// Simulate any change so the edit flow shows the draft indicator and sets the page to dirty
		currentPage.getController().editFlow.updateDocument(currentPage.getBindingContext(), Promise.all(requestPromises));
	}

	/**
	 * Updates side-effects data when an action has been triggered on a context.
	 * @param view The view that was used initially when connecting the websocket
	 * @param pathForAction Path of the context to apply the action to
	 * @param actionName Name of the action
	 * @param requestedProperties
	 * @returns Promise resolved when the side-effects data has been loaded
	 */
	async requestUpdateForAction(view: FEView, pathForAction: string, actionName: string, requestedProperties?: string[]): Promise<void> {
		const targetContext = this.findContextForUpdate(view, pathForAction);
		if (!targetContext) {
			return;
		}

		const appComponent = CollaborationUtils.getAppComponent(view);
		const sideEffectService = appComponent.getSideEffectsService();
		const sideEffectsFromAction = sideEffectService.getODataActionSideEffects(actionName, targetContext);
		const sideEffectPromises: Promise<unknown>[] = [];
		if (sideEffectsFromAction) {
			if (sideEffectsFromAction.pathExpressions?.length) {
				sideEffectPromises.push(
					sideEffectService.requestSideEffects(sideEffectsFromAction.pathExpressions, targetContext, SYNCGROUPID)
				);
			}
		}
		if (requestedProperties && requestedProperties.length > 0) {
			//clean-up of the properties to request list:
			const metaModel = view.getModel().getMetaModel();
			const metaPathForAction = this.calculateMetaPath(view, pathForAction);
			const dataModelPath = MetaModelConverter.getInvolvedDataModelObjects(metaModel.getContext(metaPathForAction));
			const propertiesToRequest = dataModelPath.targetEntityType.entityProperties
				.map((property: Property) => {
					return property.name;
				})
				.filter((prop) => requestedProperties.includes(prop));
			if (propertiesToRequest.length > 0) {
				sideEffectPromises.push(sideEffectService.requestSideEffects(propertiesToRequest, targetContext, SYNCGROUPID));
			}
		}

		await Promise.all(sideEffectPromises);
	}

	/**
	 * Finds a context to apply an update message (CHANGE, CREATE, DELETE or ACTION).
	 * @param view  The view that was used initially when connecting the websocket
	 * @param path The path of the context to be found (shall point to an entity, not a property)
	 * @returns A context if it could be found
	 */
	findContextForUpdate(view: View, path: string): Context | undefined {
		if (!path) {
			return undefined;
		}
		// Find all potential paths
		const targetPaths: string[] = [];
		while (!path.endsWith(")")) {
			targetPaths.unshift(path);
			path = path.substring(0, path.lastIndexOf("/"));
		}
		targetPaths.unshift(path);

		const parentCollectionPath = path.substring(0, path.lastIndexOf("(")); // Remove the last key

		let targetContext: Context | undefined;
		let currentContext = this.getCurrentPage(view).getBindingContext() as Context | undefined;
		while (currentContext && !targetContext) {
			if (targetPaths.includes(currentContext.getPath())) {
				targetContext = currentContext;
			}

			currentContext = currentContext.getBinding()?.getContext() as Context | undefined;
		}

		if (targetContext) {
			// Found !
			return targetContext;
		}

		// Try to find the target context in a listBinding
		const model = this.getCurrentPage(view).getBindingContext().getModel();
		const parentListBinding = model.getAllBindings().find((binding) => {
			const bindingPath = binding.isRelative() ? binding.getResolvedPath() : binding.getPath();
			return binding.isA("sap.ui.model.odata.v4.ODataListBinding") && bindingPath === parentCollectionPath;
		}) as ODataListBinding | undefined;
		// We've found a list binding that could contain the target context --> look for it
		targetContext = parentListBinding?.getAllCurrentContexts().find((context) => {
			return targetPaths.includes(context.getPath());
		});

		return targetContext;
	}

	/**
	 * Navigates after a draft was closed by another user.
	 * Navigates back if in creation mode and draft was discarded, else navigates to (recreated) target context.
	 * @param path Absolute path to navigate to
	 * @param view Current FE view
	 * @param userAction User action that triggered the navigation
	 */
	navigate(path: string, view: FEView, userAction: string): void {
		// TODO: routing.navigate doesn't consider semantic bookmarking
		const currentPage = this.getCurrentPage(view);
		const targetContext = view.getModel().bindContext(path).getBoundContext();
		if (!targetContext) {
			Log.warning("CollaborativeDraftService.navigate: Target context could not be resolved for path " + path);
			return;
		}

		const controller = currentPage.getController();
		const routing = controller._routing;
		const isCreationMode = controller.editFlow.getCreationMode();
		const isDiscard = userAction === Activity.Discard;

		if (isCreationMode && isDiscard) {
			// If the object was a newly created one, we navigate back
			routing.navigateBackFromContext(targetContext);
			return;
		}

		// Otherwise we navigate to the context, but we force its recreation so that all $selects are properly computed by internalRouting
		routing.navigateToContext(targetContext, { recreateContext: true });
	}

	getCurrentPage(view: View): FEView {
		const appComponent = CollaborationUtils.getAppComponent(view);
		return CommonUtils.getCurrentPageView(appComponent);
	}

	/**
	 * Calculates the metapath from one or more data path(s).
	 * @param view The current view
	 * @param path One ore more data path(s), in case of multiple paths separated by '|'
	 * @returns The calculated metaPath
	 */
	calculateMetaPath(view: FEView, path?: string): string {
		let metaPath = "";
		if (path) {
			// in case more than one path is sent all of them have to use the same metapath therefore we just consider the first one
			const dataPath = path.split("|")[0];
			metaPath = view.getModel().getMetaModel().getMetaPath(dataPath);
		}
		return metaPath;
	}

	init(): void {
		this.initPromise = Promise.resolve(this);
	}
}

export default class CollaborativeDraftServiceFactory extends ServiceFactory<CollaborativeDraftServiceFactory> {
	public async createInstance(oServiceContext: ServiceContext<CollaborativeDraftServiceFactory>): Promise<CollaborativeDraftService> {
		const collaborativeDraftService = new CollaborativeDraftService(oServiceContext);
		return collaborativeDraftService.initPromise;
	}
}
