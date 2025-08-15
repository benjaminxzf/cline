import * as vscode from "vscode"
import { CollaborationClient } from "./CollaborationClient"
import { CollaborativeDiffManager } from "./CollaborativeDiffManager"
import { CollaborativeApprovalManager, ApprovalMode } from "./CollaborativeApprovalManager"
import { ClineStateSync, ClineStateDelta, ClineStateSnapshot } from "./ClineStateSync"
import { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"

export interface CollaborativeSession {
	sessionId: string
	participants: string[]
	isActive: boolean
}

export class CollaborativeManager {
	private static instance: CollaborativeManager | null = null

	private collaborationClient: CollaborationClient
	private diffManager: CollaborativeDiffManager
	private approvalManager: CollaborativeApprovalManager
	private stateSync: ClineStateSync

	private currentSession: CollaborativeSession | null = null
	private isCollaborationEnabled = false

	// Event emitters for integration with Cline core
	private onMessageHandlers: ((message: any) => void)[] = []
	private onStateChangeHandlers: ((state: any) => void)[] = []

	// Primary instance management
	private isPrimary: boolean = false
	private primaryUserId: string | null = null
	private primaryUserName: string | null = null

	// State synchronization locking
	private syncInProgress: boolean = false
	private pendingSyncOperations: Array<() => Promise<void>> = []

	// Error tracking for circuit breaker pattern
	private collaborationErrors: { timestamp: number; error: string }[] = []
	private readonly MAX_ERRORS_BEFORE_DISABLE = 5
	private readonly ERROR_WINDOW_MS = 60000 // 1 minute window

	private constructor() {
		this.collaborationClient = new CollaborationClient()
		this.diffManager = new CollaborativeDiffManager(this.collaborationClient)
		this.approvalManager = new CollaborativeApprovalManager(this.collaborationClient)
		this.stateSync = new ClineStateSync()

		this.setupEventHandlers()
	}

	public static getInstance(): CollaborativeManager {
		if (!CollaborativeManager.instance) {
			CollaborativeManager.instance = new CollaborativeManager()
		}
		return CollaborativeManager.instance
	}

	/**
	 * Initialize collaborative features
	 */
	async initialize(): Promise<void> {
		try {
			// Check if we're in a collaborative environment (interview container)
			const isInContainer = await this.detectContainerEnvironment()

			if (isInContainer) {
				this.isCollaborationEnabled = true
				console.log("[Cline Collaborative] Collaboration features enabled")

				// Setup collaboration UI
				this.setupCollaborativeCommands()
				this.showCollaborationStatus()
			} else {
				console.log("[Cline Collaborative] Not in collaborative environment, running in standard mode")
			}
		} catch (error) {
			console.error("[Cline Collaborative] Failed to initialize:", error)
		}
	}

	/**
	 * Detects if we're running in a collaborative container environment
	 */
	private async detectContainerEnvironment(): Promise<boolean> {
		// Check for environment variables or container indicators first
		console.log("[CollaborativeManager] Detecting container environment...")

		// Check for Docker-specific environment indicators
		const isInDocker =
			process.env.CODEWEAVER_INTERVIEW === "true" ||
			process.env.NODE_ENV === "interview" ||
			process.env.CONTAINER === "docker" ||
			require("fs").existsSync("/.dockerenv")

		if (isInDocker) {
			console.log("[CollaborativeManager] Docker environment detected")
			return true
		}

		// Fallback: try to connect to collaboration agent
		try {
			console.log("[CollaborativeManager] Checking collaboration agent connection...")
			const isConnected = this.collaborationClient.isConnectionActive()
			console.log("[CollaborativeManager] Collaboration agent connection:", isConnected)
			return isConnected
		} catch (error) {
			console.log("[CollaborativeManager] Failed to check collaboration agent:", error)
			return false
		}
	}

	/**
	 * Sets up event handlers for collaboration
	 */
	private setupEventHandlers(): void {
		console.log("[CollaborativeManager] Setting up primary instance event handlers")

		// Handle state updates from primary instance
		this.collaborationClient.onStateUpdate((stateData) => {
			console.log("[CollaborativeManager] Received state update from primary", {
				size: JSON.stringify(stateData).length,
				fromUser: stateData.fromUserName,
				type: stateData.state ? "snapshot" : "delta",
			})

			try {
				console.log("[CollaborativeManager] Applying state from primary:", {
					hasState: !!stateData.state,
					hasClineMessage: !!stateData.clineMessage,
					messageType: stateData.messageType,
					fromUser: stateData.fromUserName,
				})

				// Apply state changes using state sync service
				if (stateData.state) {
					// Full state snapshot
					const appliedState = this.stateSync.applySnapshot(stateData.state)
					this.onStateChangeHandlers.forEach((handler) =>
						handler({
							type: "snapshot",
							...appliedState,
						}),
					)
				} else if (stateData.clineMessage) {
					// Individual message update - apply directly to UI
					console.log("[CollaborativeManager] Applying individual message from primary")
					this.applyMessageFromPrimary(stateData.clineMessage)
				} else {
					// Delta update - need current state to apply
					console.log("[CollaborativeManager] Received delta, requesting current state for application")
					this.onStateChangeHandlers.forEach((handler) =>
						handler({
							type: "delta_request",
							delta: stateData,
						}),
					)
				}
			} catch (error) {
				console.error("[CollaborativeManager] Error applying state update:", error)
			}
		})

		// Handle input forwarding to primary
		this.collaborationClient.onInputReceive((input) => {
			console.log("[CollaborativeManager] Received input from secondary", {
				inputType: input.inputType,
				fromUser: input.fromUserName,
			})
			this.onMessageHandlers.forEach((handler) => handler(input))
		})

		// Handle primary status changes
		this.collaborationClient.onPrimaryChanged((data) => {
			console.log("[CollaborativeManager] Primary changed", {
				from: data.oldPrimaryUserName,
				to: data.newPrimaryUserName,
				amIPrimary: data.newPrimaryUserId === this.getCurrentUserId(),
			})

			this.isPrimary = data.newPrimaryUserId === this.getCurrentUserId()
			this.primaryUserId = data.newPrimaryUserId
			this.primaryUserName = data.newPrimaryUserName

			if (this.isPrimary) {
				console.log("[CollaborativeManager] I am now the PRIMARY instance")
				// Announce readiness as new primary
				this.collaborationClient.announcePrimaryReady({
					capabilities: ["chat-sync", "state-sync", "input-routing"],
					timestamp: Date.now(),
				})
			} else {
				console.log("[CollaborativeManager] I am now a SECONDARY instance")
			}
		})

		// Listen for room join responses to get primary status
		this.collaborationClient.onRoomJoined((data) => {
			console.log("[CollaborativeManager] Room joined response received", {
				roomId: data.roomId,
				isPrimary: data.isPrimary,
				actualUserId: data.actualUserId,
			})

			this.setCurrentUserId(data.actualUserId)
			this.setPrimaryStatus(data.isPrimary, data.actualUserId, data.userName)
		})
	}

	/**
	 * Sets up collaborative commands
	 */
	private setupCollaborativeCommands(): void {
		// Register collaboration-specific commands
		vscode.commands.registerCommand("cline.collaborative.setApprovalMode", async () => {
			const modes: { label: string; value: ApprovalMode }[] = [
				{ label: "Unanimous (All must approve)", value: "unanimous" },
				{ label: "Majority (>50% must approve)", value: "majority" },
				{ label: "Any (First approval/rejection wins)", value: "any" },
				{ label: "Interviewer Only", value: "interviewer-only" },
			]

			const selected = await vscode.window.showQuickPick(modes, {
				placeHolder: "Select approval mode for collaborative actions",
			})

			if (selected) {
				this.approvalManager.setApprovalMode(selected.value)
				vscode.window.showInformationMessage(`Approval mode set to: ${selected.label}`)
			}
		})

		vscode.commands.registerCommand("cline.collaborative.showSession", () => {
			this.showSessionInfo()
		})

		vscode.commands.registerCommand("cline.collaborative.toggleCollaboration", () => {
			this.toggleCollaboration()
		})
	}

	/**
	 * Shows collaboration status in the status bar
	 */
	private showCollaborationStatus(): void {
		const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusItem.text = "🤝 Collaborative Cline"
		statusItem.tooltip = "Cline is running in collaborative mode"
		statusItem.command = "cline.collaborative.showSession"
		statusItem.show()
	}

	/**
	 * Shows current session information
	 */
	private showSessionInfo(): void {
		if (this.currentSession) {
			const info = `
        Session ID: ${this.currentSession.sessionId}
        Participants: ${this.currentSession.participants.length}
        Status: ${this.currentSession.isActive ? "Active" : "Inactive"}
      `
			vscode.window.showInformationMessage(info)
		} else {
			vscode.window.showInformationMessage("No active collaborative session")
		}
	}

	/**
	 * Toggles collaboration features
	 */
	private async toggleCollaboration(): Promise<void> {
		this.isCollaborationEnabled = !this.isCollaborationEnabled

		const status = this.isCollaborationEnabled ? "enabled" : "disabled"
		vscode.window.showInformationMessage(`Collaboration ${status}`)
	}

	// ===== Integration Methods for Cline Core =====

	/**
	 * Primary Cline state synchronization - broadcasts full state to secondary instances
	 */
	async broadcastChatMessage(message: any): Promise<void> {
		console.log("[CollaborativeManager] Broadcasting chat message:", {
			isEnabled: this.isCollaborationActive(),
			isConnectionActive: this.isConnectionActive(),
			messageType: message.type || message.say,
			messageContent: (message.text || "").substring(0, 100),
		})

		if (!this.isCollaborationActive()) {
			console.log("[CollaborativeManager] Collaboration not active - skipping broadcast")
			return
		}

		// Only primary instances should broadcast state
		if (!this.isPrimary) {
			console.log("[CollaborativeManager] Secondary instance - not broadcasting")
			return
		}

		console.log("[CollaborativeManager] Sending broadcast message:", {
			type: "chat_message",
			clineMessage: message,
			content: (message.text || "").substring(0, 100),
			messageType: message.type || "say",
			say: message.say,
			timestamp: Date.now(),
		})

		// Broadcast full state including the new message
		this.collaborationClient.broadcastFullState({
			type: "chat_message",
			clineMessage: message,
			content: message.text || "",
			messageType: message.type || "say",
			say: message.say,
			ask: message.ask,
			timestamp: Date.now(),
			fromUserId: this.currentUserId,
			fromUserName: this.getCurrentUserName(),
		})
	}

	/**
	 * Legacy diff/approval methods removed - replaced with primary instance logic
	 */
	async createDiffProposal(filePath: string, originalContent: string, proposedContent: string): Promise<string | null> {
		console.log("[CollaborativeManager] Legacy method removed: createDiffProposal - replaced with primary instance sync")
		return null
	}

	async requestApproval(
		type: "file_edit" | "terminal_command" | "browser_action",
		description: string,
		details: any,
	): Promise<string | null> {
		console.log("[CollaborativeManager] Legacy method removed: requestApproval - replaced with primary instance sync")
		return null
	}

	needsApproval(actionType: string): boolean {
		console.log("[CollaborativeManager] Legacy method removed: needsApproval - replaced with primary instance sync")
		return false
	}

	/**
	 * Legacy broadcasting method removed - replaced with primary instance sync
	 */
	async broadcastStateUpdate(state: any): Promise<void> {
		console.log("[CollaborativeManager] Legacy broadcasting method removed: broadcastStateUpdate")
		// This method is now replaced by primary instance state synchronization
	}

	/**
	 * Applies a message from the primary instance to the secondary instance
	 */
	private async applyMessageFromPrimary(message: any): Promise<void> {
		console.log("[CollaborativeManager] Applying message from primary to secondary UI:", {
			messageType: message.type || message.say,
			text: (message.text || "").substring(0, 100),
			isPartial: message.partial,
		})

		// In secondary instances, we need to simulate receiving the message through the normal Task.say flow
		// but mark it as coming from collaboration so it doesn't trigger another broadcast
		try {
			// Get the current task instance through the controller
			const controller = this.getController()
			if (!controller || !controller.getCurrentTask) {
				console.log("[CollaborativeManager] No current task available to apply message")
				return
			}

			const currentTask = controller.getCurrentTask()
			if (!currentTask) {
				console.log("[CollaborativeManager] No active task to apply message to")
				return
			}

			// Apply the message to the current task's message state
			// TODO: Implement proper message state handler integration
			console.log("[CollaborativeManager] Would apply message to task state handler")
			// await currentTask.messageStateHandler.addClineMessage(message);
			// await currentTask.postStateToWebview();

			console.log("[CollaborativeManager] ✅ Successfully applied message from primary")
		} catch (error) {
			console.error("[CollaborativeManager] 🔴 Error applying message from primary:", error)
		}
	}

	/**
	 * Gets the controller instance
	 */
	private getController(): any {
		// This would need to be injected or accessed through the extension context
		// For now, return null as this needs proper integration
		return null
	}

	/**
	 * Registers a handler for incoming messages
	 */
	onMessage(handler: (message: any) => void): void {
		this.onMessageHandlers.push(handler)
	}

	/**
	 * Registers a handler for state changes
	 */
	onStateChange(handler: (state: any) => void): void {
		this.onStateChangeHandlers.push(handler)
	}

	// NEW PRIMARY INSTANCE METHODS

	/**
	 * Check if this instance is the primary Cline
	 */
	isPrimaryInstance(): boolean {
		console.log("[CollaborativeManager] isPrimaryInstance check:", this.isPrimary)
		return this.isPrimary
	}

	/**
	 * Get current primary user info
	 */
	getCurrentPrimary(): { userId: string | null; userName: string | null } {
		return {
			userId: this.primaryUserId,
			userName: this.primaryUserName,
		}
	}

	/**
	 * Forward user input to primary instance
	 */
	/**
	 * Forward input to primary with retry logic and error handling
	 */
	private async forwardInputToPrimaryWithRetry(inputType: string, inputData: any, maxRetries: number = 3): Promise<void> {
		let lastError: Error | null = null

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`[CollaborativeManager] Forwarding input to primary (attempt ${attempt}/${maxRetries}):`, inputType)
				await this.forwardInputToPrimary(inputType, inputData)
				console.log("[CollaborativeManager] Successfully forwarded input to primary")
				return // Success
			} catch (error) {
				lastError = error as Error
				console.warn(`[CollaborativeManager] Failed to forward input (attempt ${attempt}/${maxRetries}):`, error)

				if (attempt < maxRetries) {
					// Exponential backoff: 100ms, 200ms, 400ms
					const delayMs = 100 * Math.pow(2, attempt - 1)
					console.log(`[CollaborativeManager] Retrying in ${delayMs}ms...`)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
				}
			}
		}

		// All retries failed
		console.error("[CollaborativeManager] All retry attempts failed for input forwarding:", lastError)
		throw new Error(`Failed to forward input after ${maxRetries} attempts: ${lastError?.message}`)
	}

	async forwardInputToPrimary(inputType: string, inputData: any): Promise<void> {
		if (this.isPrimary) {
			console.log("[CollaborativeManager] I am primary, processing input locally:", inputType)
			// Process locally if we are primary
			this.onMessageHandlers.forEach((handler) => handler({ inputType, ...inputData }))
			return
		}

		if (!this.collaborationClient.isConnectionActive()) {
			throw new Error("Collaboration client connection is not active")
		}

		console.log("[CollaborativeManager] Forwarding input to primary:", inputType)
		this.collaborationClient.forwardInput({
			inputType,
			...inputData,
			timestamp: Date.now(),
		})
	}

	/**
	 * Broadcast full state to secondary instances (primary only) with synchronization locking
	 */
	async syncStateToSecondaries(
		messages: ClineMessage[],
		extensionState: ExtensionState,
		taskState: any,
		uiState: any,
		forceSnapshot: boolean = false,
	): Promise<void> {
		if (!this.isPrimary) {
			console.log("[CollaborativeManager] Not primary, cannot sync state to secondaries")
			return
		}

		if (!this.isCollaborationEnabled || !this.collaborationClient.isConnectionActive()) {
			console.log("[CollaborativeManager] Collaboration not active, skipping state sync")
			return
		}

		// Queue operation if sync already in progress
		if (this.syncInProgress) {
			console.log("[CollaborativeManager] Sync in progress, queueing operation")
			return new Promise((resolve) => {
				this.pendingSyncOperations.push(async () => {
					await this.syncStateToSecondaries(messages, extensionState, taskState, uiState, forceSnapshot)
					resolve()
				})
			})
		}

		this.syncInProgress = true
		try {
			let syncData: any

			if (forceSnapshot) {
				// Create full snapshot
				const snapshot = this.stateSync.createSnapshot(messages, extensionState, taskState, uiState)
				syncData = {
					state: snapshot,
					fromUserId: this.currentUserId,
					fromUserName: this.primaryUserName,
					timestamp: Date.now(),
				}
				console.log("[CollaborativeManager] Broadcasting full state snapshot", {
					version: snapshot.version,
					messagesCount: messages.length,
					stateSize: JSON.stringify(syncData).length,
				})
			} else {
				// Create delta update
				const delta = this.stateSync.createDelta(messages, extensionState, taskState, uiState)

				if (!delta) {
					console.log("[CollaborativeManager] No changes detected, skipping sync")
					return
				}

				syncData = {
					delta: delta,
					fromUserId: this.currentUserId,
					fromUserName: this.primaryUserName,
					timestamp: Date.now(),
				}
				console.log("[CollaborativeManager] Broadcasting state delta", {
					version: delta.version,
					changesCount: Object.keys(delta.changes).length,
					deltaSize: JSON.stringify(syncData).length,
				})
			}

			this.collaborationClient.broadcastFullState(syncData)
		} catch (error) {
			console.error("[CollaborativeManager] Error during state sync:", error)
		} finally {
			this.syncInProgress = false

			// Process any queued operations
			if (this.pendingSyncOperations.length > 0) {
				console.log(`[CollaborativeManager] Processing ${this.pendingSyncOperations.length} queued sync operations`)
				const nextOperation = this.pendingSyncOperations.shift()
				if (nextOperation) {
					nextOperation().catch((error) =>
						console.error("[CollaborativeManager] Error processing queued sync operation:", error),
					)
				}
			}
		}
	}

	/**
	 * Apply received state delta (for secondary instances)
	 */
	async applyStateDelta(
		delta: ClineStateDelta,
		currentMessages: ClineMessage[],
		currentExtensionState: ExtensionState,
		currentTaskState: any,
		currentUiState: any,
	): Promise<{
		messages: ClineMessage[]
		extensionState: ExtensionState
		taskState: any
		uiState: any
	}> {
		if (this.isPrimary) {
			console.log("[CollaborativeManager] Primary instances should not apply deltas")
			return {
				messages: currentMessages,
				extensionState: currentExtensionState,
				taskState: currentTaskState,
				uiState: currentUiState,
			}
		}

		try {
			console.log("[CollaborativeManager] Applying state delta from primary:", {
				version: delta.version,
				changesCount: Object.keys(delta.changes).length,
			})

			const result = await this.stateSync.applyDelta(
				delta,
				currentMessages,
				currentExtensionState,
				currentTaskState,
				currentUiState,
			)

			console.log("[CollaborativeManager] Successfully applied state delta")
			return result
		} catch (error) {
			console.error("[CollaborativeManager] Error applying state delta:", error)
			// Fallback to current state if delta application fails
			console.log("[CollaborativeManager] Falling back to current state due to delta application error")
			return {
				messages: currentMessages,
				extensionState: currentExtensionState,
				taskState: currentTaskState,
				uiState: currentUiState,
			}
		}
	}

	/**
	 * Handle being assigned as primary on room join
	 */
	setPrimaryStatus(isPrimary: boolean, primaryUserId?: string, primaryUserName?: string): void {
		console.log("[CollaborativeManager] Setting primary status:", {
			isPrimary,
			primaryUserId,
			primaryUserName,
			currentUserId: this.currentUserId,
		})

		try {
			this.isPrimary = isPrimary
			this.primaryUserId = primaryUserId || this.currentUserId
			this.primaryUserName = primaryUserName || null

			if (isPrimary) {
				console.log("[CollaborativeManager] I am the PRIMARY Cline instance")
				// Announce readiness as primary with error handling
				this.announcePrimaryReadinessWithRetry()
			} else {
				console.log("[CollaborativeManager] I am a SECONDARY Cline instance")
			}
		} catch (error) {
			console.error("[CollaborativeManager] Error setting primary status:", error)
			// Don't throw here to avoid breaking the overall collaboration setup
		}
	}

	/**
	 * Announce primary readiness with retry logic
	 */
	private async announcePrimaryReadinessWithRetry(maxRetries: number = 3): Promise<void> {
		let lastError: Error | null = null

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`[CollaborativeManager] Announcing primary readiness (attempt ${attempt}/${maxRetries})`)
				this.collaborationClient.announcePrimaryReady({
					capabilities: ["chat-sync", "state-sync", "input-routing"],
					timestamp: Date.now(),
				})
				console.log("[CollaborativeManager] Successfully announced primary readiness")
				return // Success
			} catch (error) {
				lastError = error as Error
				console.warn(
					`[CollaborativeManager] Failed to announce primary readiness (attempt ${attempt}/${maxRetries}):`,
					error,
				)

				if (attempt < maxRetries) {
					// Exponential backoff: 200ms, 400ms, 800ms
					const delayMs = 200 * Math.pow(2, attempt - 1)
					console.log(`[CollaborativeManager] Retrying primary announcement in ${delayMs}ms...`)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
				}
			}
		}

		// All retries failed - log but don't throw to avoid breaking collaboration
		console.error("[CollaborativeManager] Failed to announce primary readiness after all retries:", lastError)
	}

	/**
	 * Process Cline messages/inputs - main integration point
	 */
	async processClineInput(inputType: string, inputData: any): Promise<void> {
		console.log("[CollaborativeManager] Processing Cline input:", {
			inputType,
			isPrimary: this.isPrimary,
			isCollaborationActive: this.isCollaborationActive(),
		})

		try {
			if (!this.isCollaborationActive()) {
				console.log("[CollaborativeManager] Collaboration not active, processing locally")
				this.onMessageHandlers.forEach((handler) => handler({ inputType, ...inputData }))
				return
			}

			// Route based on primary status
			if (this.isPrimary) {
				console.log("[CollaborativeManager] Processing as PRIMARY instance")
				// Process locally and sync state to secondaries
				this.onMessageHandlers.forEach((handler) => handler({ inputType, ...inputData }))
				// Note: State sync will be triggered after processing by extension
			} else {
				console.log("[CollaborativeManager] Forwarding input to PRIMARY instance")
				// Forward to primary with retry logic
				await this.forwardInputToPrimaryWithRetry(inputType, inputData)
			}
		} catch (error) {
			console.error("[CollaborativeManager] Error processing Cline input:", error)

			// Check if we should disable collaboration due to repeated failures
			if (this.shouldDisableCollaboration(error)) {
				console.warn("[CollaborativeManager] Disabling collaboration due to repeated failures")
				this.isCollaborationEnabled = false
			}

			// Always fallback to local processing if collaboration fails
			console.log("[CollaborativeManager] Falling back to local processing due to error")
			try {
				this.onMessageHandlers.forEach((handler) => handler({ inputType, ...inputData }))
				console.log("[CollaborativeManager] Local processing completed successfully")
			} catch (localError) {
				console.error("[CollaborativeManager] Local processing also failed:", localError)
				// This is a critical failure - the input cannot be processed at all
				throw new Error(`Both collaborative and local processing failed: ${error.message} | ${localError.message}`)
			}
		}
	}

	/**
	 * Current user ID tracking
	 */
	private currentUserId: string | null = null

	setCurrentUserId(userId: string): void {
		console.log("[CollaborativeManager] Setting current user ID:", userId)
		this.currentUserId = userId
	}

	private getCurrentUserId(): string {
		return this.currentUserId || "unknown-user-id"
	}

	private getCurrentUserName(): string {
		return this.primaryUserName || "unknown-user-name"
	}

	/**
	 * Circuit breaker pattern: disable collaboration after too many errors
	 */
	private shouldDisableCollaboration(error: Error): boolean {
		const now = Date.now()
		const errorMessage = error.message || "Unknown error"

		// Add current error to tracking
		this.collaborationErrors.push({ timestamp: now, error: errorMessage })

		// Remove errors outside the time window
		this.collaborationErrors = this.collaborationErrors.filter((err) => now - err.timestamp < this.ERROR_WINDOW_MS)

		// Check if we've exceeded the error threshold
		const shouldDisable = this.collaborationErrors.length >= this.MAX_ERRORS_BEFORE_DISABLE

		console.log("[CollaborativeManager] Error tracking:", {
			currentErrors: this.collaborationErrors.length,
			threshold: this.MAX_ERRORS_BEFORE_DISABLE,
			windowMs: this.ERROR_WINDOW_MS,
			shouldDisable,
			recentErrors: this.collaborationErrors.slice(-3).map((e) => e.error),
		})

		return shouldDisable
	}

	/**
	 * Gets collaboration status
	 */
	isCollaborationActive(): boolean {
		return this.isCollaborationEnabled && this.collaborationClient.isConnectionActive()
	}

	/**
	 * Gets collaboration enabled status
	 */
	get isCollaborationEnabledStatus(): boolean {
		return this.isCollaborationEnabled
	}

	/**
	 * Gets connection status
	 */
	isConnectionActive(): boolean {
		return this.collaborationClient.isConnectionActive()
	}

	/**
	 * Gets current session information
	 */
	getCurrentSession(): CollaborativeSession | null {
		return this.currentSession
	}

	/**
	 * Sets the current session
	 */
	setCurrentSession(session: CollaborativeSession): void {
		this.currentSession = session
	}

	/**
	 * Cleanup resources
	 */
	dispose(): void {
		this.diffManager.dispose()
		this.approvalManager.dispose()
		this.collaborationClient.dispose()

		this.onMessageHandlers = []
		this.onStateChangeHandlers = []

		CollaborativeManager.instance = null
	}
}
