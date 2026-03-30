import type { EntitySet } from "@sap-ux/vocabularies-types";
import type { BindingToolkitExpression, CompiledBindingToolkitExpression } from "sap/fe/base/BindingToolkit";
import { and, compileExpression, equal, ifElse, not, or, pathInModel } from "sap/fe/base/BindingToolkit";
import type { PropertiesOf } from "sap/fe/base/ClassSupport";
import { defineReference, defineUI5Class, implementInterface, property } from "sap/fe/base/ClassSupport";
import type { Ref } from "sap/fe/base/jsx-runtime/jsx";
import CommonUtils from "sap/fe/core/CommonUtils";
import type PageController from "sap/fe/core/PageController";
import BuildingBlock from "sap/fe/core/buildingBlocks/BuildingBlock";
import CommandExecution from "sap/fe/core/controls/CommandExecution";
import type { HiddenDraft } from "sap/fe/core/converters/ManifestSettings";
import * as MetaModelConverter from "sap/fe/core/converters/MetaModelConverter";
import { Draft, Entity, UI } from "sap/fe/core/helpers/BindingHelper";
import Button from "sap/m/Button";
import List from "sap/m/List";
import ResponsivePopover from "sap/m/ResponsivePopover";
import StandardListItem from "sap/m/StandardListItem";
import type Event from "sap/ui/base/Event";
import type { $ControlSettings } from "sap/ui/core/Control";
import InvisibleText from "sap/ui/core/InvisibleText";
import type Item from "sap/ui/core/Item";
import type View from "sap/ui/core/mvc/View";
import type PropertyBinding from "sap/ui/model/PropertyBinding";
import type Context from "sap/ui/model/odata/v4/Context";
import type ObjectPageController from "../ObjectPageController.controller";
import { checkDraftState } from "../ObjectPageTemplating";
@defineUI5Class("sap.fe.macros.DraftToggle")
export default class DraftToggle extends BuildingBlock<Button> {
	@implementInterface("sap.m.IOverflowToolbarContent")
	__implements__sap_m_IOverflowToolbarContent = true;

	@property({ type: "boolean" })
	public visible!: boolean;

	private _containingView!: View;

	private popover?: ResponsivePopover;

	private readonly SWITCH_TO_DRAFT_KEY = "switchToDraft";

	private readonly SWITCH_TO_ACTIVE_KEY = "switchToActive";

	@property({ type: "string" })
	public id?: string;

	@property({ type: "string" })
	public contextPath?: string;

	@defineReference()
	public switchToActiveRef!: Ref<Item>;

	@defineReference()
	public switchToDraftRef!: Ref<Item>;

	private initialSelectedKey: string = this.SWITCH_TO_ACTIVE_KEY;

	private _hiddenDraft = false;

	constructor(props: $ControlSettings & PropertiesOf<DraftToggle>, others?: $ControlSettings) {
		super(props, others);
		this.attachModelContextChange(function handleVisibility(event: Event) {
			// Forced to double cast to avoid typing errors.
			const self = event.getSource() as unknown as DraftToggle;
			if (self.content?.getBinding("visible")) {
				self.content?.getBinding("visible")?.attachEvent("change", (localEvent: Event<{}, PropertyBinding>) => {
					self.visible = localEvent.getSource().getExternalValue();
				});
				self.detachModelContextChange(handleVisibility, self);
			}
		}, this);
	}

	/**
	 * Handler for the onMetadataAvailable event.
	 */
	onMetadataAvailable(): void {
		const controller = this._getOwner()?.getRootController() as ObjectPageController;
		this._hiddenDraft = (controller.getAppComponent().getEnvironmentCapabilities().getCapabilities().HiddenDraft as HiddenDraft)
			?.enabled;
		if (!this.content && !this._hiddenDraft) {
			this.content = this.createContent();
		}
	}

	getEnabled(): boolean {
		return this.content?.getProperty("enabled") ?? true;
	}

	getOverflowToolbarConfig(): object {
		return {
			canOverflow: true
		};
	}

	handleSelectedItemChange = (selectedItemKey: string): void => {
		if (selectedItemKey !== this.initialSelectedKey) {
			(this._containingView.getController() as PageController).editFlow.toggleDraftActive(
				this._containingView.getBindingContext() as Context
			);
		}
		this.popover?.close();
	};

	/**
	 * Function to check if the entitySet is a draft root that supports collaboration.
	 * @param entitySet The current entity set.
	 * @returns Returns the Boolean value based on draft state
	 */
	checkCollaborationDraftRoot(entitySet: EntitySet): boolean {
		if (entitySet.annotations?.Common?.DraftRoot?.ShareAction) {
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Function to get the visibility for the SwitchToActive button in the object page or subobject page.
	 * @param entitySet The current entity set.
	 * @returns Returns expression binding or Boolean value based on the draft state
	 */
	getSwitchToActiveVisibility(entitySet: EntitySet): CompiledBindingToolkitExpression | boolean {
		if (checkDraftState(entitySet)) {
			if (this.checkCollaborationDraftRoot(entitySet)) {
				return compileExpression(and(pathInModel("HasActiveEntity"), UI.IsEditable));
			} else {
				return compileExpression(and(Draft.IsCreatedByMe, UI.IsEditable, not(UI.IsCreateMode)));
			}
		} else {
			return false;
		}
	}

	/**
	 * Function to get the visibility for the SwitchToDraft button in the object page or subobject page.
	 * @param entitySet The current entity set.
	 * @returns Returns expression binding or Boolean value based on the draft state
	 */
	getSwitchToDraftVisibility(entitySet: EntitySet): CompiledBindingToolkitExpression | boolean {
		if (checkDraftState(entitySet)) {
			if (this.checkCollaborationDraftRoot(entitySet)) {
				return compileExpression(and(pathInModel("HasDraftEntity"), not(UI.IsEditable)));
			} else {
				return compileExpression(and(Draft.IsCreatedByMe, not(UI.IsEditable), not(UI.IsCreateMode), pathInModel("HasDraftEntity")));
			}
		} else {
			return false;
		}
	}

	/**
	 * Function to get the visibility for the SwitchDraftAndActive button in the object page or subobject page.
	 * @param entitySet The current entity set.
	 * @returns Returns expression binding or Boolean value based on the draft state
	 */
	getVisibility(entitySet: EntitySet): CompiledBindingToolkitExpression | boolean {
		if (checkDraftState(entitySet)) {
			if (this.checkCollaborationDraftRoot(entitySet)) {
				// On an active instance, we check if there's a draft. On a draft instance, we check if there's an active entity.
				// We also check either that the draft is collaborative (access type 3) or that the draft was created by me (in case an exclusive draft was created before) --> for an exclusive draft not created by me, we don't show the toggle
				return compileExpression(
					and(
						ifElse(
							pathInModel("IsActiveEntity"),
							equal(pathInModel("HasDraftEntity"), true),
							equal(pathInModel("HasActiveEntity"), true)
						),
						or(Draft.IsOfCollaborativeType, Draft.IsCreatedByMe)
					)
				);
			} else {
				return compileExpression(and(Draft.IsCreatedByMe, not(UI.IsCreateMode)));
			}
		} else {
			return false;
		}
	}

	openSwitchActivePopover = (event: Event<{}, Button>): ResponsivePopover => {
		const sourceControl = event.getSource();
		const containingView = CommonUtils.getTargetView(sourceControl);
		if (this.popover) {
			this.popover.destroy();
			delete this.popover;
		}
		const context: Context = containingView.getBindingContext();
		const isActiveEntity = context.getObject().IsActiveEntity;
		this.initialSelectedKey = isActiveEntity ? this.SWITCH_TO_ACTIVE_KEY : this.SWITCH_TO_DRAFT_KEY;
		const popover = this.createPopover();
		this.popover = popover;

		this._containingView = containingView;
		containingView.addDependent(popover);
		popover.attachEventOnce("afterClose", () => {
			popover.destroy();
			if (this.popover === popover) {
				delete this.popover;
			}
		});
		popover.openBy(sourceControl);
		return popover;
	};

	createPopover(): ResponsivePopover {
		const draftId = this.createId("DraftToggleItemDraft")!;
		const activeId = this.createId("DraftToggleItemActive")!;
		const isDraftCurrent = this.initialSelectedKey === this.SWITCH_TO_DRAFT_KEY;
		const initialFocusId = isDraftCurrent ? activeId : draftId;
		return (
			<ResponsivePopover
				showHeader={false}
				contentWidth={"15.625rem"}
				verticalScrolling={false}
				class={"sapUiNoContentPadding"}
				placement={"Bottom"}
				initialFocus={initialFocusId}
			>
				<List>
					<StandardListItem
						id={draftId}
						title={"{sap.fe.i18n>C_COMMON_OBJECT_PAGE_DISPLAY_DRAFT_MIT}"}
						type={"Active"}
						press={(): void => this.handleSelectedItemChange(this.SWITCH_TO_DRAFT_KEY)}
					/>
					<StandardListItem
						id={activeId}
						title={"{sap.fe.i18n>C_COMMON_OBJECT_PAGE_DISPLAY_SAVED_VERSION_MIT}"}
						type={"Active"}
						press={(): void => this.handleSelectedItemChange(this.SWITCH_TO_ACTIVE_KEY)}
					/>
				</List>
			</ResponsivePopover>
		);
	}

	createContent(): Button {
		const contextPathToUse = this._getOwner()?.preprocessorContext?.fullContextPath;
		const odataMetaModel = this._getOwner()?.getMetaModel();
		const context = odataMetaModel?.createBindingContext(this.contextPath ?? contextPathToUse!);
		const entityset = MetaModelConverter.convertMetaModelContext(context!) as EntitySet;
		const textValue = ifElse(
			and(not(UI.IsEditable), not(UI.IsCreateMode), Entity.HasDraft),
			pathInModel("C_COMMON_OBJECT_PAGE_SAVED_VERSION_BUT", "sap.fe.i18n"),
			pathInModel("C_COMMON_OBJECT_PAGE_DRAFT_BUT", "sap.fe.i18n")
		);
		const visible = this.getVisibility(entityset);
		const controller = this._getOwner()?.getRootController() as ObjectPageController;
		const invisibleText = (
			<InvisibleText
				text="{sap.fe.i18n>T_HEADER_DATAPOINT_TITLE_DRAFT_SWITCHER_ARIA_BUTTON}"
				id={this.createId("AriaTextDraftSwitcher")}
			/>
		);
		invisibleText.toStatic();
		const draftToggle = (
			<Button
				id={this.createId("_dt")}
				dt:designtime="not-adaptable"
				text={textValue}
				visible={visible}
				icon="sap-icon://navigation-down-arrow"
				iconFirst={false}
				type="Transparent"
				press={(event: Event<{}, Button>): ResponsivePopover => this.openSwitchActivePopover(event)}
				ariaDescribedBy={this.createId("AriaTextDraftSwitcher") ? [this.createId("AriaTextDraftSwitcher")!] : undefined}
			/>
		);
		draftToggle.addDependent(invisibleText);
		controller.getView().addDependent(
			<CommandExecution
				command="SwitchToActiveObject"
				execute={(): void => {
					controller.editFlow.toggleDraftActive(controller.getView().getBindingContext());
				}}
				visible={this.getSwitchToActiveVisibility(entityset) as unknown as BindingToolkitExpression<boolean>}
			/>
		);
		controller.getView().addDependent(
			<CommandExecution
				command="SwitchToDraftObject"
				execute={(): void => {
					controller.editFlow.toggleDraftActive(controller.getView().getBindingContext());
				}}
				visible={this.getSwitchToDraftVisibility(entityset) as unknown as BindingToolkitExpression<boolean>}
			/>
		);
		return draftToggle;
	}
}
