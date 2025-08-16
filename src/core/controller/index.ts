import { clineEnvConfig } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { AuthService } from "@/services/auth/AuthService"
import { PostHogClientProvider, telemetryService } from "@/services/posthog/PostHogClientProvider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getCwd, getDesktopDir } from "@/utils/path"
import { Anthropic } from "@anthropic-ai/sdk"
import { buildApiHandler } from "@api/index"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { downloadTask } from "@integrations/misc/export-markdown"
import { ClineAccountService } from "@services/account/ClineAccountService"
import { McpHub } from "@services/mcp/McpHub"
import { ApiProvider, ModelInfo } from "@shared/api"
import { ChatContent } from "@shared/ChatContent"
import { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { McpMarketplaceCatalog } from "@shared/mcp"
import { Mode } from "@shared/storage/types"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { UserInfo } from "@shared/UserInfo"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import fs from "fs/promises"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { CacheService, PersistenceErrorEvent } from "../storage/CacheService"
import { ensureMcpServersDirectoryExists, ensureSettingsDirectoryExists, GlobalFileNames } from "../storage/disk"
import { Task } from "../task"
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog"
import { sendStateUpdate } from "./state/subscribeToState"
import { sendPartialMessageEvent } from "./ui/subscribeToPartialMessage"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { CollaborativeManager } from "../../collaboration/CollaborativeManager"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class Controller {
	readonly id: string
	private disposables: vscode.Disposable[] = []
	task?: Task

	mcpHub: McpHub
	accountService: ClineAccountService
	authService: AuthService
	readonly cacheService: CacheService
	private collaborativeManager: CollaborativeManager
	private isUpdatingFromCollaboration = false

	constructor(
		readonly context: vscode.ExtensionContext,
		id: string,
	) {
		this.id = id

		HostProvider.get().logToChannel("ClineProvider instantiated")
		this.accountService = ClineAccountService.getInstance()
		this.cacheService = new CacheService(context)
		this.authService = AuthService.getInstance(this)

		// Initialize cache service asynchronously - critical for extension functionality
		console.log("[Controller] ===== STARTING CACHE SERVICE INITIALIZATION =====")
		this.cacheService
			.initialize()
			.then(() => {
				console.log("[Controller] ===== CACHE SERVICE INITIALIZED SUCCESSFULLY =====")
				this.authService.restoreRefreshTokenAndRetrieveAuthInfo()

				// Force proxy configuration in interview mode
				console.log("[Controller] ===== CALLING setupInterviewModeProxy =====")
				this.setupInterviewModeProxy()
				console.log("[Controller] ===== FINISHED setupInterviewModeProxy =====")
			})
			.catch((error) => {
				console.error("[Controller] ===== CACHE SERVICE INITIALIZATION FAILED =====", error)
				console.error("CRITICAL: Failed to initialize CacheService - extension may not function properly:", error)
			})

		// Set up persistence error recovery
		this.cacheService.onPersistenceError = async ({ error }: PersistenceErrorEvent) => {
			console.error("Cache persistence failed, recovering:", error)
			try {
				await this.cacheService.reInitialize()
				await this.postStateToWebview()
				HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "Saving settings to storage failed.",
				})
			} catch (recoveryError) {
				console.error("Cache recovery failed:", recoveryError)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to save settings. Please restart the extension.",
				})
			}
		}

		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			() => ensureSettingsDirectoryExists(this.context),
			this.context.extension?.packageJSON?.version ?? "1.0.0",
		)

		// Clean up legacy checkpoints
		cleanupLegacyCheckpoints(this.context.globalStorageUri.fsPath).catch((error) => {
			console.error("Failed to cleanup legacy checkpoints:", error)
		})

		// Initialize collaborative features
		console.log("[Controller] Initializing collaborative features")
		this.collaborativeManager = CollaborativeManager.getInstance()
		this.collaborativeManager.setController(this)
		console.log("[Controller] Collaborative manager instance created")
		this.setupCollaborativeSync()
		console.log("[Controller] Collaborative sync setup complete")
	}

	async getCurrentMode(): Promise<Mode> {
		return this.cacheService.getGlobalStateKey("mode")
	}

	/**
	 * Sets up collaborative state synchronization
	 */
	private setupCollaborativeSync(): void {
		console.log("[Controller] Setting up collaborative state sync handlers")

		// Register handler for collaborative input messages
		this.collaborativeManager.onMessage(async (message) => {
			console.log("[Controller] Received collaborative input:", message.inputType)
			try {
				await this.handleCollaborativeInput(message)
			} catch (error) {
				console.error("[Controller] Error handling collaborative input:", error)
			}
		})

		// Listen for state updates from other participants
		this.collaborativeManager.onStateChange(async (incomingState) => {
			console.log("[Controller] Received collaborative state change:", incomingState?.type || "state_update")
			if (this.isUpdatingFromCollaboration) {
				// Prevent infinite loops when syncing state
				console.log("[Controller] Skipping collaborative update - already updating")
				return
			}

			try {
				console.log("[Controller] Processing collaborative state update")
				this.isUpdatingFromCollaboration = true

				// Handle different types of state updates
				if (incomingState?.type === "delta_request") {
					// Handle delta request by providing current state for application
					console.log("[Controller] Handling delta request - providing current state")
					const currentState = await this.getStateToPostToWebview()
					const taskState = this.task
						? {
								isStreaming: !!this.task,
								currentTask: "active",
								mode: await this.getCurrentMode(),
							}
						: null

					const uiState = {
						currentView: "chat",
						pendingApprovals: [],
						lastUpdated: Date.now(),
					}

					// Apply the delta to current state
					const updatedState = await this.collaborativeManager.applyStateDelta(
						incomingState.delta,
						currentState.clineMessages || [],
						currentState,
						taskState,
						uiState,
					)

					// Apply the updated state
					await this.applyCollaborativeState(updatedState)
				} else {
					// Apply incoming state to this instance
					await this.applyCollaborativeState(incomingState)
				}

				// Update webview with new state (but don't broadcast back)
				await this.postStateToWebviewInternal()
			} catch (error) {
				console.error("[Controller] Failed to apply incoming state:", error)
			} finally {
				this.isUpdatingFromCollaboration = false
			}
		})

		console.log("[Controller] Initializing collaborative manager")
		// Initialize asynchronously without blocking constructor
		this.collaborativeManager
			.initialize()
			.then(() => {
				console.log("[Controller] Collaborative manager initialization complete")
			})
			.catch((error) => {
				console.error("[Controller] Failed to initialize collaborative manager:", error)
			})
	}

	/**
	 * Get the collaborative manager instance
	 */
	getCollaborativeManager(): CollaborativeManager {
		return this.collaborativeManager
	}

	/**
	 * Sync current state to secondary instances (primary only)
	 */
	async syncStateToSecondaries(): Promise<void> {
		if (!this.collaborativeManager.isPrimaryInstance()) {
			console.log("[Controller] Not primary instance, cannot sync state")
			return
		}

		try {
			// Gather current state
			const currentState = await this.getStateToPostToWebview()
			const taskState = this.task
				? {
						isStreaming: !!this.task,
						currentTask: "active",
						mode: await this.getCurrentMode(),
					}
				: null

			const uiState = {
				currentView: "chat", // Could be enhanced to track actual UI state
				pendingApprovals: [], // Could track pending approval requests
				lastUpdated: Date.now(),
			}

			console.log("[Controller] Syncing state to secondaries", {
				messagesCount: currentState.clineMessages?.length || 0,
				hasTask: !!this.task,
				mode: currentState.mode,
			})

			await this.collaborativeManager.syncStateToSecondaries(
				currentState.clineMessages || [],
				currentState,
				taskState,
				uiState,
			)
		} catch (error) {
			console.error("[Controller] Error syncing state to secondaries:", error)
		}
	}

	/**
	 * Applies collaborative state from another participant
	 */
	private async applyCollaborativeState(incomingState: any): Promise<void> {
		if (!incomingState) return

		console.log("[Cline Collaborative] Received collaborative event:", incomingState.type || "state_update")

		// Handle different types of collaborative events
		if (incomingState.type === "chat_message" && incomingState.clineMessage) {
			// Handle individual message broadcasts for real-time sync
			console.log("[Controller] Received collaborative chat_message:", incomingState.clineMessage)
			await this.handleCollaborativeMessage(incomingState.clineMessage)
			return
		}

		if (incomingState.type === "conversation_switch" && incomingState.taskId) {
			// Handle conversation switching from other participants
			console.log("[Cline Collaborative] Other participant switched to task:", incomingState.taskId)
			// Auto-switch could be intrusive, so for now just log it
			// Could potentially show a notification or indicator in the UI
			return
		}

		if (incomingState.type === "user_response") {
			// Handle user responses (edit approvals/rejections) from other participants
			console.log("[Cline Collaborative] Other participant response:", incomingState.responseType)
			// Could potentially show this in the UI as well
			return
		}

		// Handle full state updates (existing logic)
		if (!incomingState?.state) return

		const state = incomingState.state
		console.log("[Cline Collaborative] Applying state:", Object.keys(state))

		// Apply critical collaborative state updates
		if (state.taskHistory) {
			this.cacheService.setGlobalState("taskHistory", state.taskHistory)
		}

		if (state.currentTaskItem && state.clineMessages) {
			// If there's an active task with messages, we need to sync the entire conversation
			await this.syncCurrentTask(state.currentTaskItem, state.clineMessages, state.currentFocusChainChecklist)
		}

		if (state.mode) {
			this.cacheService.setGlobalState("mode", state.mode)
		}

		// Apply other relevant state
		if (state.autoApprovalSettings) {
			this.cacheService.setGlobalState("autoApprovalSettings", state.autoApprovalSettings)
		}
	}

	/**
	 * Validates collaborative input message structure
	 */
	private validateCollaborativeInput(message: any): boolean {
		if (!message || typeof message !== "object") {
			console.error("[Controller] Invalid message: not an object")
			return false
		}

		if (!message.inputType || typeof message.inputType !== "string") {
			console.error("[Controller] Invalid message: missing or invalid inputType")
			return false
		}

		if (!message.timestamp || typeof message.timestamp !== "number") {
			console.error("[Controller] Invalid message: missing or invalid timestamp")
			return false
		}

		// Validate message is not too old (more than 30 seconds)
		const messageAge = Date.now() - message.timestamp
		if (messageAge > 30000) {
			console.warn("[Controller] Message is too old, ignoring:", messageAge + "ms")
			return false
		}

		return true
	}

	/**
	 * Handles collaborative input messages from secondary instances
	 */
	private async handleCollaborativeInput(message: any): Promise<void> {
		console.log("[Controller] Processing collaborative input:", message.inputType)

		// Validate input message
		if (!this.validateCollaborativeInput(message)) {
			console.error("[Controller] Invalid collaborative input, rejecting:", message)
			return
		}

		switch (message.inputType) {
			case "new_task":
				console.log("[Controller] Handling collaborative new task request")
				await this.initTask(message.task, message.images, message.files)
				break

			case "user_response":
				console.log("[Controller] Handling collaborative user response")
				if (this.task) {
					await this.task.handleWebviewAskResponse(message.responseType, message.text, message.images, message.files)
				} else {
					console.warn("[Controller] No active task to handle user response")
				}
				break

			case "switch_task":
				console.log("[Controller] Handling collaborative task switch")
				await this.reinitExistingTaskFromId(message.taskId)
				break

			default:
				console.warn("[Controller] Unknown collaborative input type:", message.inputType)
				break
		}

		// Sync state to other secondaries after processing
		if (this.collaborativeManager.isPrimaryInstance()) {
			await this.syncStateToSecondaries()
		}
	}

	/**
	 * Handles individual collaborative messages for real-time sync
	 */
	private async handleCollaborativeMessage(message: any): Promise<void> {
		if (!this.task) {
			console.log("[Cline Collaborative] No active task to apply collaborative message")
			return
		}

		try {
			// Add the message to the current task's conversation
			await this.task.messageStateHandler.addToClineMessages(message)

			// Send as partial message event for immediate UI update
			const protoMessage = convertClineMessageToProto(message)
			await sendPartialMessageEvent(protoMessage)

			console.log("[Cline Collaborative] Applied collaborative message:", message.type, message.say || message.ask)
		} catch (error) {
			console.error("[Cline Collaborative] Failed to apply collaborative message:", error)
		}
	}

	/**
	 * Syncs the current active task with another participant's state
	 */
	private async syncCurrentTask(currentTaskItem: any, clineMessages: any[], currentFocusChainChecklist: any): Promise<void> {
		if (!currentTaskItem) {
			// Clear current task if none is active
			if (this.task) {
				await this.clearTask()
			}
			return
		}

		// If we don't have the same task ID or our task is different, restart with synced state
		if (!this.task || this.task.taskId !== currentTaskItem.id) {
			console.log("[Cline Collaborative] Syncing to different task:", currentTaskItem.id)

			// Clear current task
			if (this.task) {
				await this.clearTask()
			}

			// Start task with synced history
			if (currentTaskItem.task && clineMessages.length > 0) {
				// Recreate task from synced state
				await this.recreateTaskFromSyncedState(currentTaskItem, clineMessages, currentFocusChainChecklist)
			}
		} else if (this.task && clineMessages.length > 0) {
			// Same task ID, sync the messages
			console.log("[Cline Collaborative] Syncing messages for task:", currentTaskItem.id)
			this.task.messageStateHandler.setClineMessages(clineMessages)

			if (currentFocusChainChecklist) {
				this.task.taskState.currentFocusChainChecklist = currentFocusChainChecklist
			}
		}
	}

	/**
	 * Recreates a task from synced collaborative state
	 */
	private async recreateTaskFromSyncedState(taskItem: any, clineMessages: any[], focusChainChecklist: any): Promise<void> {
		try {
			// Get current API configuration and mode
			const apiConfiguration = this.cacheService.getApiConfiguration()
			const mode = await this.getCurrentMode()

			// Create new task with synced content using the correct constructor
			const autoApprovalSettings = this.cacheService.getGlobalStateKey("autoApprovalSettings")
			const browserSettings = this.cacheService.getGlobalStateKey("browserSettings")
			const focusChainSettings = this.cacheService.getGlobalStateKey("focusChainSettings")
			const preferredLanguage = this.cacheService.getGlobalStateKey("preferredLanguage")
			const openaiReasoningEffort = this.cacheService.getGlobalStateKey("openaiReasoningEffort")
			const strictPlanModeEnabled = this.cacheService.getGlobalStateKey("strictPlanModeEnabled")
			const shellIntegrationTimeout = this.cacheService.getGlobalStateKey("shellIntegrationTimeout")
			const terminalReuseEnabled = this.cacheService.getGlobalStateKey("terminalReuseEnabled")
			const terminalOutputLineLimit = this.cacheService.getGlobalStateKey("terminalOutputLineLimit")
			const defaultTerminalProfile = this.cacheService.getGlobalStateKey("defaultTerminalProfile")
			const enableCheckpointsSetting = this.cacheService.getGlobalStateKey("enableCheckpointsSetting")

			this.task = new Task(
				this,
				this.mcpHub,
				(historyItem: HistoryItem) => this.updateTaskHistory(historyItem),
				() => this.postStateToWebview(),
				(taskId: string) => this.reinitExistingTaskFromId(taskId),
				() => this.cancelTask(),
				apiConfiguration,
				autoApprovalSettings,
				browserSettings,
				focusChainSettings,
				preferredLanguage,
				openaiReasoningEffort,
				mode,
				strictPlanModeEnabled ?? false,
				shellIntegrationTimeout,
				terminalReuseEnabled ?? true,
				terminalOutputLineLimit ?? 500,
				defaultTerminalProfile ?? "default",
				enableCheckpointsSetting ?? true,
				await getCwd(getDesktopDir()),
				this.cacheService,
				taskItem.task, // Use the task content from history
				[], // images
				[], // files
				taskItem, // Use the full history item
			)

			// Sync the message history
			this.task.messageStateHandler.setClineMessages(clineMessages)

			// Sync focus chain checklist
			if (focusChainChecklist) {
				this.task.taskState.currentFocusChainChecklist = focusChainChecklist
			}

			console.log("[Cline Collaborative] Successfully recreated task from synced state")
		} catch (error) {
			console.error("[Cline Collaborative] Failed to recreate task from synced state:", error)
		}
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	async dispose() {
		await this.clearTask()
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.mcpHub.dispose()

		console.error("Controller disposed")
	}

	// Auth methods
	async handleSignOut() {
		try {
			// TODO: update to clineAccountId and then move clineApiKey to a clear function.
			this.cacheService.setSecret("clineAccountId", undefined)
			this.cacheService.setGlobalState("userInfo", undefined)

			// Update API providers through cache service
			const apiConfiguration = this.cacheService.getApiConfiguration()
			const updatedConfig = {
				...apiConfiguration,
				planModeApiProvider: "openrouter" as ApiProvider,
				actModeApiProvider: "openrouter" as ApiProvider,
			}
			this.cacheService.setApiConfiguration(updatedConfig)

			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of Cline",
			})
		} catch (error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Logout failed",
			})
		}
	}

	async setUserInfo(info?: UserInfo) {
		this.cacheService.setGlobalState("userInfo", info)
	}

	async initTask(task?: string, images?: string[], files?: string[], historyItem?: HistoryItem) {
		// Skip collaborative routing if this is called from a collaboration update
		if (this.isUpdatingFromCollaboration) {
			console.log("[Controller] Skipping collaborative routing - updating from collaboration")
		} else {
			// Route new user tasks through collaborative system first
			if (task && !historyItem && this.collaborativeManager.isCollaborationActive()) {
				if (!this.collaborativeManager.isPrimaryInstance()) {
					// Forward to primary instance
					console.log("[Controller] Forwarding new task to primary instance")
					await this.collaborativeManager.processClineInput("new_task", {
						task,
						images,
						files,
						timestamp: Date.now(),
					})
					return // Don't process locally
				} else {
					console.log("[Controller] Processing new task as primary instance")
				}
			}
		}

		await this.clearTask() // ensures that an existing task doesn't exist before starting a new one, although this shouldn't be possible since user must clear task before starting a new one

		const apiConfiguration = this.cacheService.getApiConfiguration()
		const autoApprovalSettings = this.cacheService.getGlobalStateKey("autoApprovalSettings")
		const browserSettings = this.cacheService.getGlobalStateKey("browserSettings")
		const focusChainSettings = this.cacheService.getGlobalStateKey("focusChainSettings")
		const focusChainFeatureFlagEnabled = this.cacheService.getGlobalStateKey("focusChainFeatureFlagEnabled")
		const preferredLanguage = this.cacheService.getGlobalStateKey("preferredLanguage")
		const openaiReasoningEffort = this.cacheService.getGlobalStateKey("openaiReasoningEffort")
		const mode = this.cacheService.getGlobalStateKey("mode")
		const shellIntegrationTimeout = this.cacheService.getGlobalStateKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.cacheService.getGlobalStateKey("terminalReuseEnabled")
		const terminalOutputLineLimit = this.cacheService.getGlobalStateKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.cacheService.getGlobalStateKey("defaultTerminalProfile")
		const enableCheckpointsSetting = this.cacheService.getGlobalStateKey("enableCheckpointsSetting")
		const isNewUser = this.cacheService.getGlobalStateKey("isNewUser")
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const strictPlanModeEnabled = this.cacheService.getGlobalStateKey("strictPlanModeEnabled")

		const NEW_USER_TASK_COUNT_THRESHOLD = 10

		// Check if the user has completed enough tasks to no longer be considered a "new user"
		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
			this.cacheService.setGlobalState("isNewUser", false)
			await this.postStateToWebview()
		}

		if (autoApprovalSettings) {
			const updatedAutoApprovalSettings = {
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			}
			this.cacheService.setGlobalState("autoApprovalSettings", updatedAutoApprovalSettings)
		}
		// Apply remote feature flag gate to focus chain settings
		const effectiveFocusChainSettings = {
			...(focusChainSettings || { enabled: true, remindClineInterval: 6 }),
			enabled: Boolean(focusChainSettings?.enabled) && Boolean(focusChainFeatureFlagEnabled),
		}

		this.task = new Task(
			this,
			this.mcpHub,
			(historyItem) => this.updateTaskHistory(historyItem),
			() => this.postStateToWebview(),
			(taskId) => this.reinitExistingTaskFromId(taskId),
			() => this.cancelTask(),
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			effectiveFocusChainSettings,
			preferredLanguage,
			openaiReasoningEffort,
			mode,
			strictPlanModeEnabled ?? false,
			shellIntegrationTimeout,
			terminalReuseEnabled ?? true,
			terminalOutputLineLimit ?? 500,
			defaultTerminalProfile ?? "default",
			enableCheckpointsSetting ?? true,
			await getCwd(getDesktopDir()),
			this.cacheService,
			task,
			images,
			files,
			historyItem,
		)

		// Broadcast task creation to secondary instances (primary only, new tasks only)
		if (task && !historyItem && !this.isUpdatingFromCollaboration && this.collaborativeManager.isPrimaryInstance()) {
			console.log("[Controller] Broadcasting task creation to secondary instances")
			await this.collaborativeManager.broadcastTaskCreation(task, images, files)
		}

		// Broadcast user message immediately for real-time collaboration
		console.log("[Controller] initTask - task:", !!task, "historyItem:", !!historyItem)
		if (task && !historyItem) {
			// Only broadcast for new tasks, not when loading from history
			console.log("[Controller] Broadcasting new user message for collaboration")
			console.log("[Controller] Collaboration enabled:", this.collaborativeManager.isCollaborationEnabledStatus)
			console.log("[Controller] Collaboration connection active:", this.collaborativeManager.isConnectionActive())
			console.log("[Controller] Collaboration active:", this.collaborativeManager.isCollaborationActive())

			// Note: Collaborative routing is now handled at the beginning of initTask
			// Primary instances will sync state after task execution
		} else {
			console.log("[Controller] Skipping collaboration routing - task:", !!task, "historyItem:", !!historyItem)
		}

		// Execute the task
		const api = buildApiHandler(apiConfiguration, mode)
		this.task.api = api
		// Note: Task execution is handled through other methods, not a single execute() method
		console.log("[Controller] Task API handler updated for collaborative execution")

		// SYNC STATE TO SECONDARIES after task processing (primary only)
		if (task && !historyItem && this.collaborativeManager.isPrimaryInstance()) {
			console.log("[Controller] Primary instance syncing state to secondaries after task creation")
			await this.syncStateToSecondaries()
		}
	}

	async reinitExistingTaskFromId(taskId: string) {
		const history = await this.getTaskWithId(taskId)
		if (history) {
			// Route conversation switch through primary instance system
			if (this.collaborativeManager.isCollaborationActive()) {
				if (!this.collaborativeManager.isPrimaryInstance()) {
					// Forward to primary instance
					console.log("[Controller] Forwarding conversation switch to primary instance")
					await this.collaborativeManager.processClineInput("switch_task", {
						taskId: taskId,
						timestamp: Date.now(),
					})
					return // Don't process locally
				} else {
					console.log("[Controller] Processing conversation switch as primary instance")
				}
			}

			await this.initTask(undefined, undefined, undefined, history.historyItem)

			// Sync state after task switch (primary only)
			if (this.collaborativeManager.isPrimaryInstance()) {
				await this.syncStateToSecondaries()
			}
		}
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		this.cacheService.setGlobalState("telemetrySetting", telemetrySetting)
		const isOptedIn = telemetrySetting !== "disabled"
		telemetryService.updateTelemetryState(isOptedIn)
		await this.postStateToWebview()
	}

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const didSwitchToActMode = modeToSwitchTo === "act"

		// Store mode to global state
		this.cacheService.setGlobalState("mode", modeToSwitchTo)

		// Capture mode switch telemetry | Capture regardless of if we know the taskId
		telemetryService.captureModeSwitch(this.task?.ulid ?? "0", modeToSwitchTo)

		// Update API handler with new mode (buildApiHandler now selects provider based on mode)
		if (this.task) {
			const apiConfiguration = this.cacheService.getApiConfiguration()
			this.task.api = buildApiHandler({ ...apiConfiguration, ulid: this.task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebview()

		if (this.task) {
			this.task.updateMode(modeToSwitchTo)
			if (this.task.taskState.isAwaitingPlanResponse && didSwitchToActMode) {
				this.task.taskState.didRespondToPlanAskBySwitchingMode = true
				// Use chatContent if provided, otherwise use default message
				await this.task.handleWebviewAskResponse(
					"messageResponse",
					chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
					chatContent?.images || [],
					chatContent?.files || [],
				)

				return true
			} else {
				this.cancelTask()
				return false
			}
		}

		return false
	}

	async cancelTask() {
		if (this.task) {
			const { historyItem } = await this.getTaskWithId(this.task.taskId)
			try {
				await this.task.abortTask()
			} catch (error) {
				console.error("Failed to abort task", error)
			}
			await pWaitFor(
				() =>
					this.task === undefined ||
					this.task.taskState.isStreaming === false ||
					this.task.taskState.didFinishAbortingStream ||
					this.task.taskState.isWaitingForFirstChunk, // if only first chunk is processed, then there's no need to wait for graceful abort (closes edits, browser, etc)
				{
					timeout: 3_000,
				},
			).catch(() => {
				console.error("Failed to abort task")
			})
			if (this.task) {
				// 'abandoned' will prevent this cline instance from affecting future cline instance gui. this may happen if its hanging on a streaming request
				this.task.taskState.abandoned = true
			}
			await this.initTask(undefined, undefined, undefined, historyItem) // clears task again, so we need to abortTask manually above
			// Dont send the state to the webview, the new Cline instance will send state when it's ready.
			// Sending the state here sent an empty messages array to webview leading to virtuoso having to reload the entire list
		}
	}

	async handleAuthCallback(customToken: string, provider: string | null = null) {
		try {
			await this.authService.handleAuthCallback(customToken, provider ? provider : "google")

			const clineProvider: ApiProvider = "cline"

			// Get current settings to determine how to update providers
			const planActSeparateModelsSetting = this.cacheService.getGlobalStateKey("planActSeparateModelsSetting")

			const currentMode = await this.getCurrentMode()

			// Get current API configuration from cache
			const currentApiConfiguration = this.cacheService.getApiConfiguration()

			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				// Only update the current mode's provider
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = clineProvider
				} else {
					updatedConfig.actModeApiProvider = clineProvider
				}
			} else {
				// Update both modes to keep them in sync
				updatedConfig.planModeApiProvider = clineProvider
				updatedConfig.actModeApiProvider = clineProvider
			}

			// Update the API configuration through cache service
			this.cacheService.setApiConfiguration(updatedConfig)

			// Mark welcome view as completed since user has successfully logged in
			this.cacheService.setGlobalState("welcomeViewCompleted", true)

			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			console.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to Cline",
			})
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
		}
	}

	// MCP Marketplace
	private async fetchMcpMarketplaceFromApi(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get(`${clineEnvConfig.mcpBaseUrl}/marketplace`, {
				headers: {
					"Content-Type": "application/json",
				},
			})

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			// Store in global state
			this.cacheService.setGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("Failed to fetch MCP marketplace:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "Failed to fetch MCP marketplace"
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: errorMessage,
				})
			}
			return undefined
		}
	}

	private async fetchMcpMarketplaceFromApiRPC(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get(`${clineEnvConfig.mcpBaseUrl}/marketplace`, {
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "cline-vscode-extension",
				},
			})

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			// Store in global state
			this.cacheService.setGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("Failed to fetch MCP marketplace:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "Failed to fetch MCP marketplace"
				throw new Error(errorMessage)
			}
			return undefined
		}
	}

	async silentlyRefreshMcpMarketplace() {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi(true)
			if (catalog) {
				await sendMcpMarketplaceCatalogEvent(catalog)
			}
		} catch (error) {
			console.error("Failed to silently refresh MCP marketplace:", error)
		}
	}

	/**
	 * RPC variant that silently refreshes the MCP marketplace catalog and returns the result
	 * Unlike silentlyRefreshMcpMarketplace, this doesn't send a message to the webview
	 * @returns MCP marketplace catalog or undefined if refresh failed
	 */
	async silentlyRefreshMcpMarketplaceRPC() {
		try {
			return await this.fetchMcpMarketplaceFromApiRPC(true)
		} catch (error) {
			console.error("Failed to silently refresh MCP marketplace (RPC):", error)
			return undefined
		}
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code })
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			console.error("Error exchanging code for API key:", error)
			throw error
		}

		const openrouter: ApiProvider = "openrouter"
		const currentMode = await this.getCurrentMode()

		// Update API configuration through cache service
		const currentApiConfiguration = this.cacheService.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: openrouter,
			actModeApiProvider: openrouter,
			openRouterApiKey: apiKey,
		}
		this.cacheService.setApiConfiguration(updatedConfig)

		await this.postStateToWebview()
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
		// Dont send settingsButtonClicked because its bad ux if user is on welcome
	}

	private async ensureCacheDirectoryExists(): Promise<string> {
		const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
		await fs.mkdir(cacheDir, { recursive: true })
		return cacheDir
	}

	// Read OpenRouter models from disk cache
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.cacheService.getGlobalStateKey("taskHistory")
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		// if we tried to get a task that doesn't exist, remove it from state
		// FIXME: this seems to happen sometimes when the json file doesn't save to disk for some reason
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		await downloadTask(historyItem.ts, apiConversationHistory)
	}

	async deleteTaskFromState(id: string) {
		// Remove the task from history
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		this.cacheService.setGlobalState("taskHistory", updatedTaskHistory)

		// Notify the webview that the task has been deleted
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(this.id, state)

		// Sync state using primary instance system (only if primary and not updating from collaboration)
		if (!this.isUpdatingFromCollaboration && this.collaborativeManager.isPrimaryInstance()) {
			const taskState = this.task
				? {
						isStreaming: !!this.task,
						currentTask: "active",
						mode: await this.getCurrentMode(),
					}
				: null

			const uiState = {
				currentView: "chat",
				pendingApprovals: [],
				lastUpdated: Date.now(),
			}

			await this.collaborativeManager.syncStateToSecondaries(state.clineMessages || [], state, taskState, uiState)
		}
	}

	/**
	 * Internal method to update webview without broadcasting to collaborators
	 */
	private async postStateToWebviewInternal() {
		const state = await this.getStateToPostToWebview()
		// Mark state as collaborative update for UI detection
		;(state as any)._isCollaborativeUpdate = true
		;(state as any)._fromUser = "collaborative-sync"
		await sendStateUpdate(this.id, state)
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		// Get API configuration from cache for immediate access
		const apiConfiguration = this.cacheService.getApiConfiguration()
		const lastShownAnnouncementId = this.cacheService.getGlobalStateKey("lastShownAnnouncementId")
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const autoApprovalSettings = this.cacheService.getGlobalStateKey("autoApprovalSettings")
		const browserSettings = this.cacheService.getGlobalStateKey("browserSettings")
		const focusChainSettings = this.cacheService.getGlobalStateKey("focusChainSettings")
		const focusChainFeatureFlagEnabled = this.cacheService.getGlobalStateKey("focusChainFeatureFlagEnabled")
		const preferredLanguage = this.cacheService.getGlobalStateKey("preferredLanguage")
		const openaiReasoningEffort = this.cacheService.getGlobalStateKey("openaiReasoningEffort")
		const mode = this.cacheService.getGlobalStateKey("mode")
		const strictPlanModeEnabled = this.cacheService.getGlobalStateKey("strictPlanModeEnabled")
		const userInfo = this.cacheService.getGlobalStateKey("userInfo")
		const mcpMarketplaceEnabled = this.cacheService.getGlobalStateKey("mcpMarketplaceEnabled")
		const mcpDisplayMode = this.cacheService.getGlobalStateKey("mcpDisplayMode")
		const telemetrySetting = this.cacheService.getGlobalStateKey("telemetrySetting")
		const planActSeparateModelsSetting = this.cacheService.getGlobalStateKey("planActSeparateModelsSetting")
		const enableCheckpointsSetting = this.cacheService.getGlobalStateKey("enableCheckpointsSetting")
		const globalClineRulesToggles = this.cacheService.getGlobalStateKey("globalClineRulesToggles")
		const globalWorkflowToggles = this.cacheService.getGlobalStateKey("globalWorkflowToggles")
		const shellIntegrationTimeout = this.cacheService.getGlobalStateKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.cacheService.getGlobalStateKey("terminalReuseEnabled")
		const defaultTerminalProfile = this.cacheService.getGlobalStateKey("defaultTerminalProfile")
		const isNewUser = this.cacheService.getGlobalStateKey("isNewUser")
		const welcomeViewCompleted = Boolean(
			this.cacheService.getGlobalStateKey("welcomeViewCompleted") || this.authService.getInfo()?.user?.uid,
		)
		const mcpResponsesCollapsed = this.cacheService.getGlobalStateKey("mcpResponsesCollapsed")
		const terminalOutputLineLimit = this.cacheService.getGlobalStateKey("terminalOutputLineLimit")
		const localClineRulesToggles = this.cacheService.getWorkspaceStateKey("localClineRulesToggles")
		const localWindsurfRulesToggles = this.cacheService.getWorkspaceStateKey("localWindsurfRulesToggles")
		const localCursorRulesToggles = this.cacheService.getWorkspaceStateKey("localCursorRulesToggles")
		const workflowToggles = this.cacheService.getWorkspaceStateKey("workflowToggles")

		const currentTaskItem = this.task?.taskId ? (taskHistory || []).find((item) => item.id === this.task?.taskId) : undefined
		const checkpointTrackerErrorMessage = this.task?.taskState.checkpointTrackerErrorMessage
		const clineMessages = this.task?.messageStateHandler.getClineMessages() || []

		const processedTaskHistory = (taskHistory || [])
			.filter((item) => item.ts && item.task)
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 100) // for now we're only getting the latest 100 tasks, but a better solution here is to only pass in 3 for recent task history, and then get the full task history on demand when going to the task history view (maybe with pagination?)

		const latestAnnouncementId = getLatestAnnouncementId(this.context)
		// DISABLED: Version update announcements and popups
		const shouldShowAnnouncement = false // lastShownAnnouncementId !== latestAnnouncementId
		const platform = process.platform as Platform
		const distinctId = PostHogClientProvider.getInstance().distinctId
		const version = this.context.extension?.packageJSON?.version ?? ""
		const uriScheme = vscode.env.uriScheme

		return {
			version,
			apiConfiguration,
			uriScheme,
			currentTaskItem,
			checkpointTrackerErrorMessage,
			clineMessages,
			currentFocusChainChecklist: this.task?.taskState.currentFocusChainChecklist || null,
			taskHistory: processedTaskHistory,
			shouldShowAnnouncement,
			platform,
			autoApprovalSettings,
			browserSettings,
			focusChainSettings,
			focusChainFeatureFlagEnabled,
			preferredLanguage,
			openaiReasoningEffort,
			mode,
			strictPlanModeEnabled,
			userInfo,
			mcpMarketplaceEnabled,
			mcpDisplayMode,
			telemetrySetting,
			planActSeparateModelsSetting,
			enableCheckpointsSetting: enableCheckpointsSetting ?? true,
			distinctId,
			globalClineRulesToggles: globalClineRulesToggles || {},
			localClineRulesToggles: localClineRulesToggles || {},
			localWindsurfRulesToggles: localWindsurfRulesToggles || {},
			localCursorRulesToggles: localCursorRulesToggles || {},
			localWorkflowToggles: workflowToggles || {},
			globalWorkflowToggles: globalWorkflowToggles || {},
			shellIntegrationTimeout,
			terminalReuseEnabled,
			defaultTerminalProfile,
			isNewUser,
			welcomeViewCompleted: welcomeViewCompleted as boolean, // Can be undefined but is set to either true or false by the migration that runs on extension launch in extension.ts
			mcpResponsesCollapsed,
			terminalOutputLineLimit,
		}
	}

	async clearTask() {
		if (this.task) {
		}
		await this.task?.abortTask()
		this.task = undefined // removes reference to it, so once promises end it will be garbage collected
	}

	// Caching mechanism to keep track of webview messages + API conversation history per provider instance

	/*
	Now that we use retainContextWhenHidden, we don't have to store a cache of cline messages in the user's state, but we could to reduce memory footprint in long conversations.

	- We have to be careful of what state is shared between ClineProvider instances since there could be multiple instances of the extension running at once. For example when we cached cline messages using the same key, two instances of the extension could end up using the same key and overwriting each other's messages.
	- Some state does need to be shared between the instances, i.e. the API key--however there doesn't seem to be a good way to notify the other instances that the API key has changed.

	We need to use a unique identifier for each ClineProvider instance's message cache since we could be running several instances of the extension outside of just the sidebar i.e. in editor panels.

	// conversation history to send in API requests

	/*
	It seems that some API messages do not comply with vscode state requirements. Either the Anthropic library is manipulating these values somehow in the backend in a way that's creating cyclic references, or the API returns a function or a Symbol as part of the message content.
	VSCode docs about state: "The value must be JSON-stringifyable ... value — A value. MUST not contain cyclic references."
	For now we'll store the conversation history in memory, and if we need to store in state directly we'd need to do a manual conversion to ensure proper json stringification.
	*/

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = this.cacheService.getGlobalStateKey("taskHistory")
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			history[existingItemIndex] = item
		} else {
			history.push(item)
		}
		this.cacheService.setGlobalState("taskHistory", history)
		return history
	}

	/**
	 * Setup proxy configuration for interview mode
	 * Forces Cline to use the LLM proxy instead of direct API access
	 */
	private setupInterviewModeProxy(): void {
		try {
			console.log("[Controller] ====== CHECKING INTERVIEW MODE ======")
			console.log("[Controller] CODEWEAVER_INTERVIEW_MODE:", process.env.CODEWEAVER_INTERVIEW_MODE)
			console.log("[Controller] LLM_PROXY_URL:", process.env.LLM_PROXY_URL)
			console.log("[Controller] ROOM_ID:", process.env.ROOM_ID)
			console.log("[Controller] CODEWEAVER_AUTH_TOKEN:", process.env.CODEWEAVER_AUTH_TOKEN ? "[REDACTED]" : "Not provided")

			// Check if we're in interview mode
			const isInterviewMode = process.env.CODEWEAVER_INTERVIEW_MODE === "true"

			if (!isInterviewMode) {
				console.log("[Controller] Not in interview mode, using normal configuration")
				return // Not in interview mode, use normal configuration
			}

			console.log("[Controller] ====== SETTING UP INTERVIEW MODE PROXY ======")

			// Get configuration from environment
			const proxyUrl = process.env.LLM_PROXY_URL || "http://management-server:5000/api/llm/chat"
			const roomId = process.env.ROOM_ID
			const authToken = process.env.CODEWEAVER_AUTH_TOKEN

			// Force proxy configuration for both plan and act modes
			this.cacheService.setGlobalStateBatch({
				planModeApiProvider: "proxy",
				actModeApiProvider: "proxy",
				proxyUrl: proxyUrl,
				roomId: roomId,
				authToken: authToken,
				// Disable ability to change providers in UI
				settingsLocked: true,
			})

			console.log(`[Controller] ====== INTERVIEW MODE PROXY CONFIGURED ======`)
			console.log(`  - Proxy URL: ${proxyUrl}`)
			console.log(`  - Room ID: ${roomId}`)
			console.log(`  - Auth Token: ${authToken ? "[REDACTED]" : "Not provided"}`)
			console.log(`  - Settings locked: true`)

			// Verify the configuration was applied
			setTimeout(async () => {
				try {
					const planModeProvider = this.cacheService.getGlobalStateKey("planModeApiProvider")
					const actModeProvider = this.cacheService.getGlobalStateKey("actModeApiProvider")
					const proxyUrl = this.cacheService.getGlobalStateKey("proxyUrl")
					const roomId = this.cacheService.getGlobalStateKey("roomId")
					console.log(`[Controller] ====== VERIFYING PROXY CONFIG ======`)
					console.log(`  - Plan mode provider: ${planModeProvider}`)
					console.log(`  - Act mode provider: ${actModeProvider}`)
					console.log(`  - Proxy URL: ${proxyUrl}`)
					console.log(`  - Room ID: ${roomId}`)
					const settingsLocked = this.cacheService.getGlobalStateKey("settingsLocked")
					console.log(`  - Settings locked: ${settingsLocked}`)
				} catch (error) {
					console.error(`[Controller] Error verifying proxy config:`, error)
				}
			}, 1000)
		} catch (error) {
			console.error("[Controller] Failed to setup interview mode proxy:", error)
		}
	}
}
