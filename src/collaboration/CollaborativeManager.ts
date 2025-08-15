import * as vscode from "vscode"
import { CollaborationClient } from "./CollaborationClient"
import { CollaborativeDiffManager } from "./CollaborativeDiffManager"
import { CollaborativeApprovalManager, ApprovalMode } from "./CollaborativeApprovalManager"

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

	private currentSession: CollaborativeSession | null = null
	private isCollaborationEnabled = false

	// Event emitters for integration with Cline core
	private onMessageHandlers: ((message: any) => void)[] = []
	private onStateChangeHandlers: ((state: any) => void)[] = []

	private constructor() {
		this.collaborationClient = new CollaborationClient()
		this.diffManager = new CollaborativeDiffManager(this.collaborationClient)
		this.approvalManager = new CollaborativeApprovalManager(this.collaborationClient)

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
		// Check for environment variables or collaboration agent availability
		try {
			// Try to connect to collaboration agent
			return this.collaborationClient.isConnectionActive()
		} catch {
			return false
		}
	}

	/**
	 * Sets up event handlers for collaboration
	 */
	private setupEventHandlers(): void {
		// Handle chat messages from other participants
		this.collaborationClient.onChatMessage((message) => {
			this.onMessageHandlers.forEach((handler) => handler(message))
		})

		// Handle state updates from other participants
		this.collaborationClient.onStateUpdate((state) => {
			this.onStateChangeHandlers.forEach((handler) => handler(state))
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
	 * Intercepts and broadcasts chat messages
	 */
	async broadcastChatMessage(message: any): Promise<void> {
		if (!this.isCollaborationEnabled) return

		this.collaborationClient.emitChatMessage({
			type: "chat_message",
			content: message.content,
			role: message.role,
			timestamp: Date.now(),
		})
	}

	/**
	 * Creates a collaborative diff proposal
	 */
	async createDiffProposal(filePath: string, originalContent: string, proposedContent: string): Promise<string | null> {
		if (!this.isCollaborationEnabled) return null

		return await this.diffManager.createDiffProposal(filePath, originalContent, proposedContent)
	}

	/**
	 * Creates an approval request for actions that need consensus
	 */
	async requestApproval(
		type: "file_edit" | "terminal_command" | "browser_action",
		description: string,
		details: any,
	): Promise<string | null> {
		if (!this.isCollaborationEnabled) return null

		return await this.approvalManager.createApprovalRequest(type, description, details)
	}

	/**
	 * Checks if an action needs approval in collaborative mode
	 */
	needsApproval(actionType: string): boolean {
		if (!this.isCollaborationEnabled) return false

		// Define which actions need approval
		const actionsNeedingApproval = ["file_edit", "terminal_command", "browser_action", "create_file", "delete_file"]

		return actionsNeedingApproval.includes(actionType)
	}

	/**
	 * Broadcasts state updates to other participants
	 */
	async broadcastStateUpdate(state: any): Promise<void> {
		if (!this.isCollaborationEnabled) return

		this.collaborationClient.emitStateUpdate({
			type: "state_update",
			state,
			timestamp: Date.now(),
		})
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

	/**
	 * Gets collaboration status
	 */
	isCollaborationActive(): boolean {
		return this.isCollaborationEnabled && this.collaborationClient.isConnectionActive()
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
