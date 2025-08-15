import * as vscode from "vscode"
import { CollaborationClient, DiffDecoration } from "./CollaborationClient"

export interface PendingDiff {
	id: string
	filePath: string
	originalContent: string
	proposedContent: string
	decorations: vscode.DecorationOptions[]
	decorationType: vscode.TextEditorDecorationType
	timestamp: number
}

export class CollaborativeDiffManager {
	private collaborationClient: CollaborationClient
	private pendingDiffs = new Map<string, PendingDiff>()
	private diffDecorationTypes = new Map<string, vscode.TextEditorDecorationType>()

	// Decoration types for different diff states
	private additionDecorationType: vscode.TextEditorDecorationType
	private deletionDecorationType: vscode.TextEditorDecorationType
	private modificationDecorationType: vscode.TextEditorDecorationType

	constructor(collaborationClient: CollaborationClient) {
		this.collaborationClient = collaborationClient

		// Create decoration types for diff visualization
		this.additionDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(0, 255, 0, 0.2)",
			isWholeLine: true,
			gutterIconPath: undefined,
			gutterIconSize: "contain",
		})

		this.deletionDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(255, 0, 0, 0.2)",
			isWholeLine: true,
			gutterIconPath: undefined,
			gutterIconSize: "contain",
			textDecoration: "line-through",
		})

		this.modificationDecorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(255, 255, 0, 0.2)",
			isWholeLine: true,
			gutterIconPath: undefined,
			gutterIconSize: "contain",
		})

		// Listen for diff proposals from other participants
		this.collaborationClient.onDiffProposed((diffs) => {
			this.applyRemoteDiffDecorations(diffs)
		})
	}

	/**
	 * Creates a proposed diff and broadcasts it to other participants
	 */
	async createDiffProposal(filePath: string, originalContent: string, proposedContent: string): Promise<string> {
		const diffId = `diff_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

		// Calculate diff decorations
		const decorations = this.calculateDiffDecorations(originalContent, proposedContent)

		// Create decoration type for this specific diff
		const decorationType = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(100, 149, 237, 0.2)",
			isWholeLine: true,
			after: {
				contentText: " (Proposed by Cline)",
				color: "rgba(100, 149, 237, 0.8)",
				fontStyle: "italic",
			},
		})

		// Store pending diff
		const pendingDiff: PendingDiff = {
			id: diffId,
			filePath,
			originalContent,
			proposedContent,
			decorations,
			decorationType,
			timestamp: Date.now(),
		}

		this.pendingDiffs.set(diffId, pendingDiff)
		this.diffDecorationTypes.set(diffId, decorationType)

		// Apply decorations locally
		await this.applyDiffDecorations(pendingDiff)

		// Broadcast to other participants
		const diffData: DiffDecoration[] = decorations.map((decoration) => ({
			range: decoration.range,
			content: proposedContent.substring(decoration.range.start.character, decoration.range.end.character),
			type: "modification", // We'll enhance this later to detect addition/deletion
			filePath,
		}))

		this.collaborationClient.emitDiffProposed(diffData)

		return diffId
	}

	/**
	 * Applies diff decorations from remote participants
	 */
	private async applyRemoteDiffDecorations(diffs: DiffDecoration[]): Promise<void> {
		const decorationsByFile = new Map<string, DiffDecoration[]>()

		// Group decorations by file
		diffs.forEach((diff) => {
			if (!decorationsByFile.has(diff.filePath)) {
				decorationsByFile.set(diff.filePath, [])
			}
			decorationsByFile.get(diff.filePath)!.push(diff)
		})

		// Apply decorations to each file
		for (const [filePath, fileDiffs] of decorationsByFile) {
			const editor = vscode.window.visibleTextEditors.find((editor) => editor.document.fileName.endsWith(filePath))

			if (editor) {
				const decorations = fileDiffs.map((diff) => ({
					range: diff.range,
					hoverMessage: `Proposed change: ${diff.type}`,
				}))

				const decorationType = this.getDecorationTypeForDiffType(fileDiffs[0].type)
				editor.setDecorations(decorationType, decorations)
			}
		}
	}

	/**
	 * Calculates diff decorations between original and proposed content
	 */
	private calculateDiffDecorations(originalContent: string, proposedContent: string): vscode.DecorationOptions[] {
		const originalLines = originalContent.split("\n")
		const proposedLines = proposedContent.split("\n")
		const decorations: vscode.DecorationOptions[] = []

		// Simple line-by-line diff (can be enhanced with more sophisticated algorithms)
		const maxLines = Math.max(originalLines.length, proposedLines.length)

		for (let i = 0; i < maxLines; i++) {
			const originalLine = originalLines[i] || ""
			const proposedLine = proposedLines[i] || ""

			if (originalLine !== proposedLine) {
				const range = new vscode.Range(i, 0, i, proposedLine.length)
				decorations.push({
					range,
					hoverMessage: `Changed from: "${originalLine}" to: "${proposedLine}"`,
				})
			}
		}

		return decorations
	}

	/**
	 * Applies diff decorations to the editor
	 */
	private async applyDiffDecorations(pendingDiff: PendingDiff): Promise<void> {
		const editor = vscode.window.visibleTextEditors.find((editor) => editor.document.fileName.endsWith(pendingDiff.filePath))

		if (editor) {
			editor.setDecorations(pendingDiff.decorationType, pendingDiff.decorations)
		}
	}

	/**
	 * Gets the appropriate decoration type for a diff type
	 */
	private getDecorationTypeForDiffType(diffType: string): vscode.TextEditorDecorationType {
		switch (diffType) {
			case "addition":
				return this.additionDecorationType
			case "deletion":
				return this.deletionDecorationType
			case "modification":
			default:
				return this.modificationDecorationType
		}
	}

	/**
	 * Clears all diff decorations for a specific diff ID
	 */
	clearDiffDecorations(diffId: string): void {
		const pendingDiff = this.pendingDiffs.get(diffId)
		if (pendingDiff) {
			const editor = vscode.window.visibleTextEditors.find((editor) =>
				editor.document.fileName.endsWith(pendingDiff.filePath),
			)

			if (editor) {
				editor.setDecorations(pendingDiff.decorationType, [])
			}

			this.pendingDiffs.delete(diffId)

			const decorationType = this.diffDecorationTypes.get(diffId)
			if (decorationType) {
				decorationType.dispose()
				this.diffDecorationTypes.delete(diffId)
			}
		}
	}

	/**
	 * Clears all pending diffs
	 */
	clearAllDiffs(): void {
		for (const diffId of this.pendingDiffs.keys()) {
			this.clearDiffDecorations(diffId)
		}
	}

	/**
	 * Gets all pending diffs
	 */
	getPendingDiffs(): Map<string, PendingDiff> {
		return new Map(this.pendingDiffs)
	}

	/**
	 * Cleanup resources
	 */
	dispose(): void {
		this.clearAllDiffs()
		this.additionDecorationType.dispose()
		this.deletionDecorationType.dispose()
		this.modificationDecorationType.dispose()
	}
}
