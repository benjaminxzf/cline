import * as vscode from "vscode"
import { ClineMessage, ExtensionState } from "@shared/ExtensionMessage"

/**
 * Comprehensive state synchronization for collaborative Cline instances
 * Manages serialization, compression, and versioning of Cline state
 */

export interface ClineStateDelta {
	version: number
	timestamp: number
	changes: {
		messages?: {
			added?: ClineMessage[]
			updated?: { index: number; message: ClineMessage }[]
			removed?: number[]
		}
		extensionState?: Partial<ExtensionState>
		taskState?: {
			isStreaming?: boolean
			currentTask?: string
			mode?: string
			[key: string]: any
		}
		uiState?: {
			currentView?: string
			pendingApprovals?: any[]
			inlineEdits?: any[]
			[key: string]: any
		}
	}
	fromUserId?: string
	fromUserName?: string
}

export interface ClineStateSnapshot {
	version: number
	timestamp: number
	fullState: {
		messages: ClineMessage[]
		extensionState: ExtensionState
		taskState: any
		uiState: any
	}
	fromUserId?: string
	fromUserName?: string
}

export class ClineStateSync {
	private currentVersion: number = 0
	private lastSnapshot: ClineStateSnapshot | null = null
	private lastSyncTime: number = 0

	constructor() {
		console.log("[ClineStateSync] State synchronization service initialized")
	}

	/**
	 * Create a complete state snapshot for new joiners or major sync events
	 */
	createSnapshot(messages: ClineMessage[], extensionState: ExtensionState, taskState: any, uiState: any): ClineStateSnapshot {
		const startTime = Date.now()
		this.currentVersion++
		const timestamp = Date.now()

		console.log("[ClineStateSync] 📸 Creating state snapshot:", {
			version: this.currentVersion,
			messagesCount: messages.length,
			hasExtensionState: !!extensionState,
			hasTaskState: !!taskState,
			hasUiState: !!uiState,
			timestamp,
			timestampReadable: new Date(timestamp).toISOString(),
			previousVersion: this.currentVersion - 1,
		})

		const snapshot: ClineStateSnapshot = {
			version: this.currentVersion,
			timestamp,
			fullState: {
				messages: this.deepClone(messages),
				extensionState: this.deepClone(extensionState),
				taskState: this.deepClone(taskState),
				uiState: this.deepClone(uiState),
			},
		}

		this.lastSnapshot = snapshot
		this.lastSyncTime = timestamp

		const snapshotSize = JSON.stringify(snapshot).length
		const creationTime = Date.now() - startTime

		console.log("[ClineStateSync] ✅ State snapshot created successfully:", {
			version: this.currentVersion,
			messagesCount: messages.length,
			size: `${snapshotSize} bytes`,
			sizeKB: `${(snapshotSize / 1024).toFixed(2)} KB`,
			creationTimeMs: creationTime,
			timestamp: snapshot.timestamp,
			lastSnapshotVersion: this.lastSnapshot?.version,
		})

		return snapshot
	}

	/**
	 * Create a delta update containing only changes since last sync
	 */
	createDelta(messages: ClineMessage[], extensionState: ExtensionState, taskState: any, uiState: any): ClineStateDelta | null {
		const startTime = Date.now()

		if (!this.lastSnapshot) {
			console.log("[ClineStateSync] ⚠️ No baseline snapshot available, cannot create delta", {
				hasMessages: !!messages,
				messagesCount: messages?.length || 0,
				hasExtensionState: !!extensionState,
				hasTaskState: !!taskState,
				hasUiState: !!uiState,
			})
			return null
		}

		console.log("[ClineStateSync] 🔄 Creating state delta:", {
			version: this.currentVersion + 1,
			baselineVersion: this.lastSnapshot.version,
			messagesCount: messages.length,
			baselineMessagesCount: this.lastSnapshot.fullState.messages.length,
			timestamp: Date.now(),
			timeSinceLastSync: Date.now() - this.lastSyncTime,
		})

		this.currentVersion++
		const timestamp = Date.now()

		const delta: ClineStateDelta = {
			version: this.currentVersion,
			timestamp,
			changes: {},
		}

		// Detect message changes
		const messageChanges = this.detectMessageChanges(this.lastSnapshot.fullState.messages, messages)
		if (messageChanges) {
			delta.changes.messages = messageChanges
			console.log("[ClineStateSync] 📝 Message changes detected:", {
				added: messageChanges.added?.length || 0,
				updated: messageChanges.updated?.length || 0,
				removed: messageChanges.removed?.length || 0,
			})
		}

		// Detect extension state changes
		const stateChanges = this.detectStateChanges(this.lastSnapshot.fullState.extensionState, extensionState)
		if (stateChanges && Object.keys(stateChanges).length > 0) {
			delta.changes.extensionState = stateChanges
			console.log("[ClineStateSync] ⚙️ Extension state changes detected:", {
				changedFields: Object.keys(stateChanges),
				changeCount: Object.keys(stateChanges).length,
			})
		}

		// Detect task state changes
		const taskChanges = this.detectObjectChanges(this.lastSnapshot.fullState.taskState, taskState)
		if (taskChanges && Object.keys(taskChanges).length > 0) {
			delta.changes.taskState = taskChanges
			console.log("[ClineStateSync] 🎯 Task state changes detected:", {
				changedFields: Object.keys(taskChanges),
				changeCount: Object.keys(taskChanges).length,
			})
		}

		// Detect UI state changes
		const uiChanges = this.detectObjectChanges(this.lastSnapshot.fullState.uiState, uiState)
		if (uiChanges && Object.keys(uiChanges).length > 0) {
			delta.changes.uiState = uiChanges
			console.log("[ClineStateSync] 🖥️ UI state changes detected:", {
				changedFields: Object.keys(uiChanges),
				changeCount: Object.keys(uiChanges).length,
			})
		}

		// Only return delta if there are actual changes
		if (Object.keys(delta.changes).length === 0) {
			console.log("[ClineStateSync] ℹ️ No changes detected, skipping delta creation", {
				version: this.currentVersion,
				messagesCount: messages.length,
				baselineMessagesCount: this.lastSnapshot.fullState.messages.length,
				checkTimeMs: Date.now() - startTime,
			})
			return null
		}

		// Update baseline for next delta
		this.lastSnapshot = this.createSnapshot(messages, extensionState, taskState, uiState)

		const deltaSize = JSON.stringify(delta).length
		const creationTime = Date.now() - startTime

		console.log("[ClineStateSync] ✅ State delta created successfully:", {
			version: this.currentVersion,
			changesCount: Object.keys(delta.changes).length,
			changeTypes: Object.keys(delta.changes),
			size: `${deltaSize} bytes`,
			sizeKB: `${(deltaSize / 1024).toFixed(2)} KB`,
			creationTimeMs: creationTime,
			timestamp: delta.timestamp,
			timestampReadable: new Date(delta.timestamp).toISOString(),
		})

		return delta
	}

	/**
	 * Apply a received state snapshot to local state
	 */
	applySnapshot(snapshot: ClineStateSnapshot): {
		messages: ClineMessage[]
		extensionState: ExtensionState
		taskState: any
		uiState: any
	} {
		console.log("[ClineStateSync] Applying state snapshot", {
			version: snapshot.version,
			timestamp: snapshot.timestamp,
			fromUser: snapshot.fromUserName,
		})

		this.currentVersion = Math.max(this.currentVersion, snapshot.version)
		this.lastSnapshot = snapshot
		this.lastSyncTime = snapshot.timestamp

		return {
			messages: this.deepClone(snapshot.fullState.messages),
			extensionState: this.deepClone(snapshot.fullState.extensionState),
			taskState: this.deepClone(snapshot.fullState.taskState),
			uiState: this.deepClone(snapshot.fullState.uiState),
		}
	}

	/**
	 * Apply a received state delta to local state
	 */
	applyDelta(
		delta: ClineStateDelta,
		currentMessages: ClineMessage[],
		currentExtensionState: ExtensionState,
		currentTaskState: any,
		currentUiState: any,
	): {
		messages: ClineMessage[]
		extensionState: ExtensionState
		taskState: any
		uiState: any
	} {
		console.log("[ClineStateSync] Applying state delta", {
			version: delta.version,
			timestamp: delta.timestamp,
			fromUser: delta.fromUserName,
			changesCount: Object.keys(delta.changes).length,
		})

		// Validate version ordering
		if (delta.version <= this.currentVersion) {
			console.warn("[ClineStateSync] Received old delta version, ignoring", {
				receivedVersion: delta.version,
				currentVersion: this.currentVersion,
			})
			return {
				messages: currentMessages,
				extensionState: currentExtensionState,
				taskState: currentTaskState,
				uiState: currentUiState,
			}
		}

		this.currentVersion = delta.version
		this.lastSyncTime = delta.timestamp

		// Apply message changes
		let newMessages = [...currentMessages]
		if (delta.changes.messages) {
			newMessages = this.applyMessageChanges(newMessages, delta.changes.messages)
		}

		// Apply extension state changes
		let newExtensionState = { ...currentExtensionState }
		if (delta.changes.extensionState) {
			newExtensionState = { ...newExtensionState, ...delta.changes.extensionState }
		}

		// Apply task state changes
		let newTaskState = { ...currentTaskState }
		if (delta.changes.taskState) {
			newTaskState = { ...newTaskState, ...delta.changes.taskState }
		}

		// Apply UI state changes
		let newUiState = { ...currentUiState }
		if (delta.changes.uiState) {
			newUiState = { ...newUiState, ...delta.changes.uiState }
		}

		return {
			messages: newMessages,
			extensionState: newExtensionState,
			taskState: newTaskState,
			uiState: newUiState,
		}
	}

	/**
	 * Get current version for conflict detection
	 */
	getCurrentVersion(): number {
		return this.currentVersion
	}

	/**
	 * Check if we need a full resync based on time or version gaps
	 */
	needsFullResync(remoteVersion: number): boolean {
		const versionGap = Math.abs(remoteVersion - this.currentVersion)
		const timeGap = Date.now() - this.lastSyncTime

		const needsResync = versionGap > 10 || timeGap > 30000 || !this.lastSnapshot

		if (needsResync) {
			console.log("[ClineStateSync] Full resync needed", {
				versionGap,
				timeGap,
				hasSnapshot: !!this.lastSnapshot,
			})
		}

		return needsResync
	}

	// Private helper methods

	private detectMessageChanges(oldMessages: ClineMessage[], newMessages: ClineMessage[]): any {
		const changes: any = {}

		// Simple approach: detect added messages at the end
		if (newMessages.length > oldMessages.length) {
			const addedMessages = newMessages.slice(oldMessages.length)
			changes.added = addedMessages
			console.log("[ClineStateSync] Detected added messages:", addedMessages.length)
		}

		// Detect updated messages (check last few messages for modifications)
		const checkCount = Math.min(5, oldMessages.length, newMessages.length)
		const updated = []

		for (let i = Math.max(0, oldMessages.length - checkCount); i < oldMessages.length; i++) {
			if (i < newMessages.length) {
				const oldMsg = oldMessages[i]
				const newMsg = newMessages[i]

				if (JSON.stringify(oldMsg) !== JSON.stringify(newMsg)) {
					updated.push({ index: i, message: newMsg })
				}
			}
		}

		if (updated.length > 0) {
			changes.updated = updated
			console.log("[ClineStateSync] Detected updated messages:", updated.length)
		}

		return Object.keys(changes).length > 0 ? changes : null
	}

	private detectStateChanges(oldState: ExtensionState, newState: ExtensionState): Partial<ExtensionState> {
		const changes: Partial<ExtensionState> = {}

		// Compare key fields that change frequently
		const watchedFields = ["mode", "currentTaskItem", "currentFocusChainChecklist", "shouldShowAnnouncement", "taskHistory"]

		for (const field of watchedFields) {
			const oldValue = (oldState as any)[field]
			const newValue = (newState as any)[field]

			if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
				;(changes as any)[field] = newValue
			}
		}

		return changes
	}

	private detectObjectChanges(oldObj: any, newObj: any): any {
		const changes: any = {}

		if (!oldObj || !newObj) {
			return newObj
		}

		for (const key in newObj) {
			if (JSON.stringify(oldObj[key]) !== JSON.stringify(newObj[key])) {
				changes[key] = newObj[key]
			}
		}

		return changes
	}

	private applyMessageChanges(messages: ClineMessage[], changes: any): ClineMessage[] {
		let result = [...messages]

		if (changes.added) {
			result = result.concat(changes.added)
		}

		if (changes.updated) {
			for (const update of changes.updated) {
				if (update.index < result.length) {
					result[update.index] = update.message
				}
			}
		}

		if (changes.removed) {
			// Remove in reverse order to maintain indices
			for (const index of changes.removed.sort((a: number, b: number) => b - a)) {
				if (index < result.length) {
					result.splice(index, 1)
				}
			}
		}

		return result
	}

	private deepClone<T>(obj: T): T {
		return JSON.parse(JSON.stringify(obj))
	}
}
