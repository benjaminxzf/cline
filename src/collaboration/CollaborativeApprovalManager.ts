import * as vscode from "vscode"
import { CollaborationClient, ApprovalRequest } from "./CollaborationClient"

export interface ApprovalState {
	request: ApprovalRequest
	webviewPanel?: vscode.WebviewPanel
	statusBarItem?: vscode.StatusBarItem
	participants: Map<string, { userId: string; userName: string; vote?: "approve" | "reject" }>
}

export type ApprovalMode = "unanimous" | "majority" | "any" | "interviewer-only"

export class CollaborativeApprovalManager {
	private collaborationClient: CollaborationClient
	private currentApprovals = new Map<string, ApprovalState>()
	private approvalMode: ApprovalMode = "majority"
	private statusBarItem: vscode.StatusBarItem

	constructor(collaborationClient: CollaborationClient) {
		this.collaborationClient = collaborationClient

		// Create status bar item for approval notifications
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
		this.statusBarItem.command = "cline.collaborative.showApprovals"

		// Listen for approval events
		this.collaborationClient.onApprovalRequest((request) => {
			this.handleApprovalRequest(request)
		})

		this.collaborationClient.onApprovalVote((voteData) => {
			this.handleApprovalVote(voteData)
		})

		// Register commands
		vscode.commands.registerCommand("cline.collaborative.showApprovals", () => {
			this.showApprovalsPanel()
		})

		vscode.commands.registerCommand("cline.collaborative.approve", (requestId: string) => {
			this.vote(requestId, "approve")
		})

		vscode.commands.registerCommand("cline.collaborative.reject", (requestId: string) => {
			this.vote(requestId, "reject")
		})
	}

	/**
	 * Sets the approval mode for the session
	 */
	setApprovalMode(mode: ApprovalMode): void {
		this.approvalMode = mode
		this.updateStatusBar()
	}

	/**
	 * Creates a new approval request and broadcasts it
	 */
	async createApprovalRequest(
		type: "file_edit" | "terminal_command" | "browser_action",
		description: string,
		details: any,
	): Promise<string> {
		const requestId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

		// Create approval request
		const request: Omit<ApprovalRequest, "votes" | "status" | "timestamp"> = {
			id: requestId,
			type,
			description,
			details,
		}

		// Broadcast to other participants
		this.collaborationClient.emitApprovalRequest(request)

		// Create local approval state
		const approvalState: ApprovalState = {
			request: {
				...request,
				votes: new Map(),
				status: "pending",
				timestamp: Date.now(),
			},
			participants: new Map(),
		}

		this.currentApprovals.set(requestId, approvalState)
		this.updateStatusBar()

		return requestId
	}

	/**
	 * Handles incoming approval requests from other participants
	 */
	private async handleApprovalRequest(request: ApprovalRequest): Promise<void> {
		const approvalState: ApprovalState = {
			request,
			participants: new Map(),
		}

		this.currentApprovals.set(request.id, approvalState)
		this.updateStatusBar()

		// Show approval notification
		await this.showApprovalNotification(request)
	}

	/**
	 * Handles incoming votes from other participants
	 */
	private handleApprovalVote(voteData: any): void {
		const { requestId, vote, userId, userName } = voteData
		const approvalState = this.currentApprovals.get(requestId)

		if (approvalState) {
			// Update participant vote
			approvalState.participants.set(userId, { userId, userName, vote })

			// Update request votes
			approvalState.request.votes.set(userId, vote)

			// Check if consensus is reached
			const consensusResult = this.checkConsensus(approvalState)
			if (consensusResult !== null) {
				approvalState.request.status = consensusResult ? "approved" : "rejected"
				this.finalizeApproval(requestId, consensusResult)
			}

			this.updateApprovalUI(requestId)
		}
	}

	/**
	 * Cast a vote for an approval request
	 */
	vote(requestId: string, vote: "approve" | "reject"): void {
		const currentUser = this.getCurrentUser()

		// Broadcast vote to other participants
		this.collaborationClient.emitApprovalVote(requestId, vote, currentUser.userId)

		// Handle vote locally
		this.handleApprovalVote({
			requestId,
			vote,
			userId: currentUser.userId,
			userName: currentUser.userName,
		})
	}

	/**
	 * Checks if consensus has been reached based on the approval mode
	 */
	private checkConsensus(approvalState: ApprovalState): boolean | null {
		const votes = Array.from(approvalState.request.votes.values())
		const totalParticipants = approvalState.participants.size

		if (votes.length === 0) return null

		const approveVotes = votes.filter((vote) => vote === "approve").length
		const rejectVotes = votes.filter((vote) => vote === "reject").length

		switch (this.approvalMode) {
			case "unanimous":
				if (votes.length === totalParticipants) {
					return approveVotes === totalParticipants
				}
				return null

			case "majority":
				if (votes.length > totalParticipants / 2) {
					return approveVotes > rejectVotes
				}
				return null

			case "any":
				return approveVotes > 0 ? true : rejectVotes > 0 ? false : null

			case "interviewer-only":
				// Find interviewer vote (simplified - assumes first participant is interviewer)
				const interviewerVote = votes[0]
				return interviewerVote === "approve"

			default:
				return null
		}
	}

	/**
	 * Finalizes an approval decision
	 */
	private async finalizeApproval(requestId: string, approved: boolean): Promise<void> {
		const approvalState = this.currentApprovals.get(requestId)
		if (!approvalState) return

		// Show completion notification
		const message = approved
			? `✅ Action approved: ${approvalState.request.description}`
			: `❌ Action rejected: ${approvalState.request.description}`

		vscode.window.showInformationMessage(message)

		// Execute the action if approved
		if (approved) {
			await this.executeApprovedAction(approvalState.request)
		}

		// Clean up
		this.closeApprovalUI(requestId)
		this.currentApprovals.delete(requestId)
		this.updateStatusBar()
	}

	/**
	 * Executes an approved action
	 */
	private async executeApprovedAction(request: ApprovalRequest): Promise<void> {
		try {
			switch (request.type) {
				case "file_edit":
					await this.executeFileEdit(request.details)
					break
				case "terminal_command":
					await this.executeTerminalCommand(request.details)
					break
				case "browser_action":
					await this.executeBrowserAction(request.details)
					break
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to execute approved action: ${error}`)
		}
	}

	/**
	 * Executes a file edit action
	 */
	private async executeFileEdit(details: any): Promise<void> {
		const { filePath, content } = details
		const uri = vscode.Uri.file(filePath)

		// Open document and apply changes
		const document = await vscode.workspace.openTextDocument(uri)
		const editor = await vscode.window.showTextDocument(document)

		const edit = new vscode.WorkspaceEdit()
		const fullRange = new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)

		edit.replace(uri, fullRange, content)
		await vscode.workspace.applyEdit(edit)
	}

	/**
	 * Executes a terminal command
	 */
	private async executeTerminalCommand(details: any): Promise<void> {
		const { command } = details
		const terminal = vscode.window.activeTerminal || vscode.window.createTerminal("Cline Collaborative")
		terminal.sendText(command)
		terminal.show()
	}

	/**
	 * Executes a browser action
	 */
	private async executeBrowserAction(details: any): Promise<void> {
		// Implementation would depend on browser integration
		console.log("Executing browser action:", details)
	}

	/**
	 * Shows approval notification to user
	 */
	private async showApprovalNotification(request: ApprovalRequest): Promise<void> {
		const action = await vscode.window.showInformationMessage(
			`🤝 Approval needed: ${request.description}`,
			{ modal: false },
			"Approve",
			"Reject",
			"View Details",
		)

		switch (action) {
			case "Approve":
				this.vote(request.id, "approve")
				break
			case "Reject":
				this.vote(request.id, "reject")
				break
			case "View Details":
				this.showApprovalDetails(request.id)
				break
		}
	}

	/**
	 * Shows approval details panel
	 */
	private showApprovalDetails(requestId: string): void {
		const approvalState = this.currentApprovals.get(requestId)
		if (!approvalState) return

		const panel = vscode.window.createWebviewPanel("approvalDetails", "Approval Details", vscode.ViewColumn.Beside, {
			enableScripts: true,
		})

		panel.webview.html = this.getApprovalDetailsHtml(approvalState)
		approvalState.webviewPanel = panel
	}

	/**
	 * Generates HTML for approval details panel
	 */
	private getApprovalDetailsHtml(approvalState: ApprovalState): string {
		const { request, participants } = approvalState

		return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Approval Details</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
          .header { border-bottom: 1px solid #ddd; padding-bottom: 10px; margin-bottom: 20px; }
          .details { margin: 20px 0; }
          .participants { margin-top: 20px; }
          .participant { display: flex; justify-content: space-between; margin: 10px 0; }
          .vote { padding: 4px 8px; border-radius: 4px; }
          .approve { background: #d4edda; color: #155724; }
          .reject { background: #f8d7da; color: #721c24; }
          .pending { background: #fff3cd; color: #856404; }
          .actions { margin-top: 20px; }
          button { margin: 5px; padding: 10px 20px; cursor: pointer; }
          .approve-btn { background: #28a745; color: white; border: none; border-radius: 4px; }
          .reject-btn { background: #dc3545; color: white; border: none; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>${request.description}</h2>
          <p><strong>Type:</strong> ${request.type}</p>
          <p><strong>Status:</strong> ${request.status}</p>
        </div>
        
        <div class="details">
          <h3>Details:</h3>
          <pre>${JSON.stringify(request.details, null, 2)}</pre>
        </div>
        
        <div class="participants">
          <h3>Participants:</h3>
          ${Array.from(participants.values())
				.map(
					(p) => `
            <div class="participant">
              <span>${p.userName}</span>
              <span class="vote ${p.vote || "pending"}">${p.vote || "Pending"}</span>
            </div>
          `,
				)
				.join("")}
        </div>
        
        <div class="actions">
          <button class="approve-btn" onclick="vote('approve')">Approve</button>
          <button class="reject-btn" onclick="vote('reject')">Reject</button>
        </div>
        
        <script>
          const vscode = acquireVsCodeApi();
          function vote(decision) {
            vscode.postMessage({ command: 'vote', requestId: '${request.id}', vote: decision });
          }
        </script>
      </body>
      </html>
    `
	}

	/**
	 * Shows approvals panel with all pending approvals
	 */
	private showApprovalsPanel(): void {
		// Implementation for showing all pending approvals
		console.log("Showing approvals panel with", this.currentApprovals.size, "pending approvals")
	}

	/**
	 * Updates approval UI for a specific request
	 */
	private updateApprovalUI(requestId: string): void {
		const approvalState = this.currentApprovals.get(requestId)
		if (approvalState?.webviewPanel) {
			approvalState.webviewPanel.webview.html = this.getApprovalDetailsHtml(approvalState)
		}
	}

	/**
	 * Closes approval UI for a specific request
	 */
	private closeApprovalUI(requestId: string): void {
		const approvalState = this.currentApprovals.get(requestId)
		if (approvalState?.webviewPanel) {
			approvalState.webviewPanel.dispose()
		}
	}

	/**
	 * Updates the status bar with current approval count
	 */
	private updateStatusBar(): void {
		const pendingCount = this.currentApprovals.size

		if (pendingCount > 0) {
			this.statusBarItem.text = `🤝 ${pendingCount} approval${pendingCount === 1 ? "" : "s"} pending`
			this.statusBarItem.show()
		} else {
			this.statusBarItem.hide()
		}
	}

	/**
	 * Gets current user information (simplified)
	 */
	private getCurrentUser(): { userId: string; userName: string } {
		// This would be integrated with your auth system
		return {
			userId: "current-user-id",
			userName: "Current User",
		}
	}

	/**
	 * Cleanup resources
	 */
	dispose(): void {
		for (const [requestId] of this.currentApprovals) {
			this.closeApprovalUI(requestId)
		}
		this.currentApprovals.clear()
		this.statusBarItem.dispose()
	}
}
