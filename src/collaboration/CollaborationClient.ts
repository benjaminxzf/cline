import { io, Socket } from "socket.io-client"
import * as vscode from "vscode"

export interface ClineEvent {
	type: string
	data: any
	timestamp: number
	userId?: string
	sessionId?: string
}

export interface DiffDecoration {
	range: vscode.Range
	content: string
	type: "addition" | "deletion" | "modification"
	filePath: string
}

export interface ApprovalRequest {
	id: string
	type: "file_edit" | "terminal_command" | "browser_action"
	description: string
	details: any
	votes: Map<string, "approve" | "reject">
	status: "pending" | "approved" | "rejected"
	timestamp: number
}

export class CollaborationClient {
	private socket: Socket | null = null
	private isConnected = false
	private reconnectAttempts = 0
	private maxReconnectAttempts = 5
	private reconnectDelay = 2000

	// Event handlers
	private onChatMessageHandlers: ((message: any) => void)[] = []
	private onDiffProposedHandlers: ((diffs: DiffDecoration[]) => void)[] = []
	private onApprovalRequestHandlers: ((request: ApprovalRequest) => void)[] = []
	private onApprovalVoteHandlers: ((vote: any) => void)[] = []
	private onStateUpdateHandlers: ((state: any) => void)[] = []

	constructor() {
		this.connect()
	}

	private connect() {
		try {
			// Connect to the existing collaboration agent running on port 30001
			this.socket = io("http://localhost:30001", {
				transports: ["websocket"],
				timeout: 5000,
				auth: {
					type: "cline-extension",
					extensionVersion: vscode.extensions.getExtension("saoudrizwan.claude-dev")?.packageJSON?.version || "1.0.0",
				},
			})

			this.setupSocketListeners()
		} catch (error) {
			console.error("[Cline Collaboration] Failed to connect:", error)
			this.scheduleReconnect()
		}
	}

	private setupSocketListeners() {
		if (!this.socket) return

		this.socket.on("connect", () => {
			console.log("[Cline Collaboration] Connected to collaboration agent")
			this.isConnected = true
			this.reconnectAttempts = 0

			// Announce that Cline collaboration is ready
			this.socket?.emit("cline-ready", {
				timestamp: Date.now(),
				capabilities: ["chat-sync", "diff-sync", "approval-voting", "state-sync"],
			})
		})

		this.socket.on("disconnect", () => {
			console.log("[Cline Collaboration] Disconnected from collaboration agent")
			this.isConnected = false
			this.scheduleReconnect()
		})

		this.socket.on("connect_error", (error) => {
			console.error("[Cline Collaboration] Connection error:", error)
			this.scheduleReconnect()
		})

		// Listen for collaborative events from other participants
		this.socket.on("cline-chat-message", (data) => {
			this.onChatMessageHandlers.forEach((handler) => handler(data))
		})

		this.socket.on("cline-diff-proposed", (data) => {
			this.onDiffProposedHandlers.forEach((handler) => handler(data.decorations))
		})

		this.socket.on("cline-approval-request", (data) => {
			this.onApprovalRequestHandlers.forEach((handler) => handler(data))
		})

		this.socket.on("cline-approval-vote", (data) => {
			this.onApprovalVoteHandlers.forEach((handler) => handler(data))
		})

		this.socket.on("cline-state-sync", (data) => {
			this.onStateUpdateHandlers.forEach((handler) => handler(data))
		})
	}

	private scheduleReconnect() {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error("[Cline Collaboration] Max reconnection attempts reached")
			return
		}

		this.reconnectAttempts++
		setTimeout(() => {
			console.log(`[Cline Collaboration] Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
			this.connect()
		}, this.reconnectDelay * this.reconnectAttempts)
	}

	// Event emission methods
	emitChatMessage(message: any) {
		if (!this.isConnected || !this.socket) return

		this.socket.emit("cline-chat-message", {
			...message,
			timestamp: Date.now(),
		})
	}

	emitDiffProposed(decorations: DiffDecoration[]) {
		if (!this.isConnected || !this.socket) return

		this.socket.emit("cline-diff-proposed", {
			decorations,
			timestamp: Date.now(),
		})
	}

	emitApprovalRequest(request: Omit<ApprovalRequest, "votes" | "status" | "timestamp">) {
		if (!this.isConnected || !this.socket) return

		this.socket.emit("cline-approval-request", {
			...request,
			votes: new Map(),
			status: "pending",
			timestamp: Date.now(),
		})
	}

	emitApprovalVote(requestId: string, vote: "approve" | "reject", userId: string) {
		if (!this.isConnected || !this.socket) return

		this.socket.emit("cline-approval-vote", {
			requestId,
			vote,
			userId,
			timestamp: Date.now(),
		})
	}

	emitStateUpdate(state: any) {
		if (!this.isConnected || !this.socket) return

		this.socket.emit("cline-state-sync", {
			...state,
			timestamp: Date.now(),
		})
	}

	// Event subscription methods
	onChatMessage(handler: (message: any) => void) {
		this.onChatMessageHandlers.push(handler)
	}

	onDiffProposed(handler: (diffs: DiffDecoration[]) => void) {
		this.onDiffProposedHandlers.push(handler)
	}

	onApprovalRequest(handler: (request: ApprovalRequest) => void) {
		this.onApprovalRequestHandlers.push(handler)
	}

	onApprovalVote(handler: (vote: any) => void) {
		this.onApprovalVoteHandlers.push(handler)
	}

	onStateUpdate(handler: (state: any) => void) {
		this.onStateUpdateHandlers.push(handler)
	}

	// Utility methods
	isConnectionActive(): boolean {
		return this.isConnected
	}

	dispose() {
		if (this.socket) {
			this.socket.disconnect()
			this.socket = null
		}
		this.isConnected = false

		// Clear all handlers
		this.onChatMessageHandlers = []
		this.onDiffProposedHandlers = []
		this.onApprovalRequestHandlers = []
		this.onApprovalVoteHandlers = []
		this.onStateUpdateHandlers = []
	}
}
