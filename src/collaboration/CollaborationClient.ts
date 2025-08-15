import { io, Socket } from "socket.io-client"
import * as vscode from "vscode"

// Legacy interfaces for compatibility - simplified since we don't need approval system
export interface ApprovalRequest {
	id: string
	type: string
	timestamp: number
}

export interface DiffDecoration {
	range: any
	type: string
	filePath?: string
}

export interface ClineEvent {
	type: string
	data: any
}

export interface ClineStateSync {
	state: any
	version: number
	timestamp: number
	fromUserId?: string
	fromUserName?: string
}

export interface ClineInputForward {
	inputType: string
	inputData: any
	timestamp: number
	fromUserId?: string
	fromUserName?: string
}

export interface PrimaryChangeData {
	oldPrimaryUserId: string
	oldPrimaryUserName: string
	newPrimaryUserId: string
	newPrimaryUserName: string
	timestamp: number
}

export class CollaborationClient {
	private socket: Socket | null = null
	private isConnected = false
	private reconnectAttempts = 0
	private maxReconnectAttempts = 5
	private reconnectDelay = 2000

	// Event handlers for primary instance sync
	private onStateUpdateHandlers: ((state: any) => void)[] = []
	private onInputReceiveHandlers: ((input: any) => void)[] = []
	private onPrimaryChangedHandlers: ((data: any) => void)[] = []
	private onRoomJoinedHandlers: ((data: any) => void)[] = []

	constructor() {
		this.connect()
	}

	private connect() {
		try {
			const extensionVersion = vscode.extensions.getExtension("saoudrizwan.claude-dev")?.packageJSON?.version || "1.0.0"

			// VS Code extensions run in Node.js, not browser context
			// The collaboration agent runs on port 30001 inside the container
			// which is exposed to localhost on the same port
			const collaborationHost = "http://localhost:30001"

			console.log("[CollaborationClient] 🔌 Initiating connection to collaboration agent:", {
				host: collaborationHost,
				transports: ["websocket"],
				timeout: 5000,
				extensionVersion,
				reconnectAttempt: this.reconnectAttempts,
				timestamp: new Date().toISOString(),
				processId: process.pid,
				nodeVersion: process.version,
			})

			// Connect to the collaboration agent on port 30001
			this.socket = io(collaborationHost, {
				transports: ["websocket"],
				timeout: 5000,
				auth: {
					type: "cline-extension",
					extensionVersion,
				},
				reconnection: true,
				reconnectionDelay: 1000,
				reconnectionAttempts: 5,
			})

			this.setupSocketListeners()
		} catch (error) {
			console.error("[CollaborationClient] Failed to initialize connection:", error)
			this.scheduleReconnect()
		}
	}

	private setupSocketListeners() {
		if (!this.socket) return

		this.socket.on("connect", () => {
			console.log("[CollaborationClient] ✅ Connected to collaboration agent", {
				socketId: this.socket?.id,
				isConnected: this.isConnected,
				reconnectAttempts: this.reconnectAttempts,
				timestamp: new Date().toISOString(),
				transport: this.socket?.io?.engine?.transport?.name,
			})
			this.isConnected = true
			this.reconnectAttempts = 0

			// Announce that Cline collaboration is ready
			const capabilities = ["chat-sync", "diff-sync", "approval-voting", "state-sync"]
			console.log("[CollaborationClient] 📢 Announcing cline-ready with capabilities:", capabilities)
			this.socket?.emit("cline-ready", {
				timestamp: Date.now(),
				capabilities,
				socketId: this.socket?.id,
			})
		})

		this.socket.on("disconnect", (reason: string) => {
			console.log("[CollaborationClient] ❌ Disconnected from collaboration agent", {
				reason,
				wasConnected: this.isConnected,
				socketId: this.socket?.id,
				timestamp: new Date().toISOString(),
			})
			this.isConnected = false
			this.scheduleReconnect()
		})

		this.socket.on("connect_error", (error) => {
			console.error("[CollaborationClient] 🔴 Connection error:", {
				error: error.message,
				type: (error as any).type,
				description: (error as any).description,
				reconnectAttempts: this.reconnectAttempts,
				timestamp: new Date().toISOString(),
				stack: error.stack?.split("\n").slice(0, 3).join(" "),
			})
			// Don't schedule reconnect - socket.io will handle it with the reconnection options
		})

		// Listen for primary instance sync events
		console.log("[CollaborationClient] 🔧 Setting up primary instance event listeners for:", [
			"cline-state-apply",
			"cline-input-receive",
			"cline-primary-changed",
			"cline-primary-ready",
			"room-joined",
		])

		this.socket.on("cline-state-apply", (data) => {
			const dataSize = JSON.stringify(data).length
			console.log("[CollaborationClient] 📨 Received state synchronization from primary:", {
				size: `${dataSize} bytes`,
				sizeKB: `${(dataSize / 1024).toFixed(2)} KB`,
				fromUser: data.fromUserName || "unknown",
				fromUserId: data.fromUserId,
				timestamp: data.timestamp,
				timestampReadable: new Date(data.timestamp).toISOString(),
				hasState: !!data.state,
				hasDelta: !!data.delta,
				handlerCount: this.onStateUpdateHandlers.length,
			})

			try {
				this.onStateUpdateHandlers.forEach((handler, index) => {
					console.log(
						`[CollaborationClient] Calling state update handler ${index + 1}/${this.onStateUpdateHandlers.length}`,
					)
					handler(data)
				})
				console.log("[CollaborationClient] ✅ All state update handlers completed successfully")
			} catch (error) {
				console.error("[CollaborationClient] 🔴 Error in state update handlers:", error)
			}
		})

		this.socket.on("cline-input-receive", (data) => {
			console.log("[CollaborationClient] 🎯 Received input for primary processing:", {
				inputType: data.inputType,
				fromUser: data.fromUserName || "unknown",
				fromUserId: data.fromUserId,
				timestamp: data.timestamp,
				timestampReadable: new Date(data.timestamp).toISOString(),
				hasInputData: !!data.inputData,
				inputDataKeys: data.inputData ? Object.keys(data.inputData) : [],
				handlerCount: this.onInputReceiveHandlers.length,
			})

			try {
				this.onInputReceiveHandlers.forEach((handler, index) => {
					console.log(
						`[CollaborationClient] Calling input receive handler ${index + 1}/${this.onInputReceiveHandlers.length}`,
					)
					handler(data)
				})
				console.log("[CollaborationClient] ✅ All input receive handlers completed successfully")
			} catch (error) {
				console.error("[CollaborationClient] 🔴 Error in input receive handlers:", error)
			}
		})

		this.socket.on("cline-primary-changed", (data) => {
			console.log("[CollaborationClient] 🔄 Primary instance changed:", {
				from: data.oldPrimaryUserName || "unknown",
				fromUserId: data.oldPrimaryUserId,
				to: data.newPrimaryUserName || "unknown",
				toUserId: data.newPrimaryUserId,
				timestamp: data.timestamp,
				timestampReadable: new Date(data.timestamp).toISOString(),
				handlerCount: this.onPrimaryChangedHandlers.length,
			})

			try {
				this.onPrimaryChangedHandlers.forEach((handler, index) => {
					console.log(
						`[CollaborationClient] Calling primary changed handler ${index + 1}/${this.onPrimaryChangedHandlers.length}`,
					)
					handler(data)
				})
				console.log("[CollaborationClient] ✅ All primary changed handlers completed successfully")
			} catch (error) {
				console.error("[CollaborationClient] 🔴 Error in primary changed handlers:", error)
			}
		})

		this.socket.on("cline-primary-ready", (data) => {
			console.log("[CollaborationClient] 🚀 Primary instance is ready:", {
				primaryUser: data.primaryUserName || "unknown",
				primaryUserId: data.primaryUserId,
				capabilities: data.capabilities || [],
				timestamp: data.timestamp,
				timestampReadable: new Date(data.timestamp).toISOString(),
			})
			// Could trigger UI updates to show primary is ready
		})

		this.socket.on("room-joined", (data) => {
			console.log("[CollaborationClient] 🏠 Room joined successfully:", {
				roomId: data.roomId,
				isPrimary: data.isPrimary,
				actualUserId: data.actualUserId,
				userName: data.userName,
				timestamp: Date.now(),
				handlerCount: this.onRoomJoinedHandlers.length,
			})

			try {
				this.onRoomJoinedHandlers.forEach((handler, index) => {
					console.log(
						`[CollaborationClient] Calling room joined handler ${index + 1}/${this.onRoomJoinedHandlers.length}`,
					)
					handler(data)
				})
				console.log("[CollaborationClient] ✅ All room joined handlers completed successfully")
			} catch (error) {
				console.error("[CollaborationClient] 🔴 Error in room joined handlers:", error)
			}
		})
	}

	private scheduleReconnect() {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.error("[CollaborationClient] 🚫 Max reconnection attempts reached:", {
				maxAttempts: this.maxReconnectAttempts,
				totalTime: (this.reconnectDelay * this.reconnectAttempts) / 1000 + "s",
				timestamp: new Date().toISOString(),
			})
			return
		}

		this.reconnectAttempts++
		const nextDelay = this.reconnectDelay * this.reconnectAttempts
		console.log(
			`[CollaborationClient] ⏱️ Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`,
			{
				delayMs: nextDelay,
				delaySec: nextDelay / 1000 + "s",
				scheduledFor: new Date(Date.now() + nextDelay).toISOString(),
			},
		)

		setTimeout(() => {
			console.log(`[CollaborationClient] 🔄 Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`)
			this.connect()
		}, nextDelay)
	}

	// Primary instance event emission methods
	broadcastFullState(stateData: any) {
		const dataSize = JSON.stringify(stateData).length
		console.log("[CollaborationClient] 📡 Broadcasting full state:", {
			isConnected: this.isConnected,
			hasSocket: !!this.socket,
			socketId: this.socket?.id,
			socketConnected: this.socket?.connected,
			size: `${dataSize} bytes`,
			sizeKB: `${(dataSize / 1024).toFixed(2)} KB`,
			timestamp: stateData.timestamp,
			timestampReadable: new Date(stateData.timestamp).toISOString(),
			fromUser: stateData.fromUserName || "unknown",
			hasState: !!stateData.state,
			hasDelta: !!stateData.delta,
			messageType: stateData.type,
		})

		if (!this.isConnected || !this.socket || !this.socket.connected) {
			console.warn("[CollaborationClient] ⚠️ Cannot broadcast state - not connected", {
				isConnected: this.isConnected,
				hasSocket: !!this.socket,
				socketId: this.socket?.id,
				socketConnected: this.socket?.connected,
			})
			return
		}

		try {
			console.log("[CollaborationClient] 📤 Emitting cline-state-full event to collaboration agent")
			this.socket.emit("cline-state-full", stateData)
			console.log("[CollaborationClient] ✅ State broadcast completed - event sent to collaboration agent")
		} catch (error) {
			console.error("[CollaborationClient] 🔴 Error broadcasting state:", error)
		}
	}

	forwardInput(inputData: any) {
		console.log("[CollaborationClient] 🎯 Forwarding input to primary instance:", {
			isConnected: this.isConnected,
			hasSocket: !!this.socket,
			socketId: this.socket?.id,
			inputType: inputData.inputType,
			timestamp: inputData.timestamp,
			timestampReadable: new Date(inputData.timestamp).toISOString(),
			hasInputData: !!inputData.inputData,
			inputDataKeys: inputData.inputData ? Object.keys(inputData.inputData) : [],
		})

		if (!this.isConnected || !this.socket) {
			console.warn("[CollaborationClient] ⚠️ Cannot forward input - not connected", {
				isConnected: this.isConnected,
				hasSocket: !!this.socket,
				socketId: this.socket?.id,
				inputType: inputData.inputType,
			})
			return
		}

		try {
			console.log("[CollaborationClient] 📤 Emitting cline-input-forward to primary")
			this.socket.emit("cline-input-forward", inputData)
			console.log("[CollaborationClient] ✅ Input forwarding completed successfully")
		} catch (error) {
			console.error("[CollaborationClient] 🔴 Error forwarding input:", error)
		}
	}

	announcePrimaryReady(readinessData: any) {
		console.log("[CollaborationClient] 🚀 Announcing primary readiness:", {
			isConnected: this.isConnected,
			hasSocket: !!this.socket,
			socketId: this.socket?.id,
			capabilities: readinessData.capabilities || [],
			timestamp: readinessData.timestamp,
			timestampReadable: new Date(readinessData.timestamp).toISOString(),
		})

		if (!this.isConnected || !this.socket) {
			console.warn("[CollaborationClient] ⚠️ Cannot announce readiness - not connected", {
				isConnected: this.isConnected,
				hasSocket: !!this.socket,
				socketId: this.socket?.id,
			})
			return
		}

		try {
			console.log("[CollaborationClient] 📢 Emitting cline-primary-ready announcement")
			this.socket.emit("cline-primary-ready", readinessData)
			console.log("[CollaborationClient] ✅ Primary readiness announcement completed successfully")
		} catch (error) {
			console.error("[CollaborationClient] 🔴 Error announcing primary readiness:", error)
		}
	}

	// Event subscription methods for primary instance sync
	onStateUpdate(handler: (state: any) => void) {
		console.log("[CollaborationClient] 📝 Registered state update handler", {
			totalHandlers: this.onStateUpdateHandlers.length + 1,
			handlerFunction: handler.name || "anonymous",
		})
		this.onStateUpdateHandlers.push(handler)
	}

	onInputReceive(handler: (input: any) => void) {
		console.log("[CollaborationClient] 🎯 Registered input receive handler", {
			totalHandlers: this.onInputReceiveHandlers.length + 1,
			handlerFunction: handler.name || "anonymous",
		})
		this.onInputReceiveHandlers.push(handler)
	}

	onPrimaryChanged(handler: (data: any) => void) {
		console.log("[CollaborationClient] 🔄 Registered primary changed handler", {
			totalHandlers: this.onPrimaryChangedHandlers.length + 1,
			handlerFunction: handler.name || "anonymous",
		})
		this.onPrimaryChangedHandlers.push(handler)
	}

	onRoomJoined(handler: (data: any) => void) {
		console.log("[CollaborationClient] 🏠 Registered room joined handler", {
			totalHandlers: this.onRoomJoinedHandlers.length + 1,
			handlerFunction: handler.name || "anonymous",
		})
		this.onRoomJoinedHandlers.push(handler)
	}

	// Legacy methods for compatibility
	onApprovalRequest(handler: (request: any) => void) {
		console.warn("[CollaborationClient] Legacy onApprovalRequest called - functionality moved to ApprovalManager")
	}

	onApprovalVote(handler: (voteData: any) => void) {
		console.warn("[CollaborationClient] Legacy onApprovalVote called - functionality moved to ApprovalManager")
	}

	emitApprovalRequest(request: any) {
		console.warn("[CollaborationClient] Legacy emitApprovalRequest called - functionality moved to ApprovalManager")
	}

	emitApprovalVote(vote: any) {
		console.warn("[CollaborationClient] Legacy emitApprovalVote called - functionality moved to ApprovalManager")
	}

	onDiffProposed(handler: (diffs: any) => void) {
		console.warn("[CollaborationClient] Legacy onDiffProposed called - functionality moved to DiffManager")
	}

	emitDiffProposed(diffs: any) {
		console.warn("[CollaborationClient] Legacy emitDiffProposed called - functionality moved to DiffManager")
	}

	// Utility methods
	isConnectionActive(): boolean {
		const isActive = this.isConnected && !!this.socket?.connected
		console.log("[CollaborationClient] 🔍 Connection status check:", {
			isConnected: this.isConnected,
			hasSocket: !!this.socket,
			socketConnected: this.socket?.connected,
			socketId: this.socket?.id,
			isActive,
			reconnectAttempts: this.reconnectAttempts,
		})
		return isActive
	}

	dispose() {
		console.log("[CollaborationClient] 🧹 Disposing collaboration client:", {
			hasSocket: !!this.socket,
			isConnected: this.isConnected,
			socketId: this.socket?.id,
			handlerCounts: {
				stateUpdate: this.onStateUpdateHandlers.length,
				inputReceive: this.onInputReceiveHandlers.length,
				primaryChanged: this.onPrimaryChangedHandlers.length,
				roomJoined: this.onRoomJoinedHandlers.length,
			},
		})

		if (this.socket) {
			console.log("[CollaborationClient] 🔌 Disconnecting socket")
			this.socket.disconnect()
			this.socket = null
		}
		this.isConnected = false

		// Clear all handlers
		console.log("[CollaborationClient] 🗑️ Clearing all event handlers")
		this.onStateUpdateHandlers = []
		this.onInputReceiveHandlers = []
		this.onPrimaryChangedHandlers = []
		this.onRoomJoinedHandlers = []

		console.log("[CollaborationClient] ✅ Collaboration client disposed successfully")
	}
}
