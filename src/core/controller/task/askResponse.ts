import { Controller } from ".."
import { Empty } from "@shared/proto/cline/common"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { ClineAskResponse } from "../../../shared/WebviewMessage"

/**
 * Handles a response from the webview for a previous ask operation
 *
 * @param controller The controller instance
 * @param request The request containing response type, optional text and optional images
 * @returns Empty response
 */
export async function askResponse(controller: Controller, request: AskResponseRequest): Promise<Empty> {
	try {
		console.log("[askResponse] Received user response:", {
			responseType: request.responseType,
			hasText: !!request.text,
			hasImages: !!request.images?.length,
			hasFiles: !!request.files?.length,
		})

		if (!controller.task) {
			console.warn("askResponse: No active task to receive response")
			return Empty.create()
		}

		// Map the string responseType to the ClineAskResponse enum
		let responseType: ClineAskResponse
		switch (request.responseType) {
			case "yesButtonClicked":
				responseType = "yesButtonClicked"
				break
			case "noButtonClicked":
				responseType = "noButtonClicked"
				break
			case "messageResponse":
				responseType = "messageResponse"
				break
			default:
				console.warn(`askResponse: Unknown response type: ${request.responseType}`)
				return Empty.create()
		}

		// Route user response through primary instance system
		const collaborativeManager = controller.getCollaborativeManager()
		console.log("[askResponse] Checking collaboration status:", collaborativeManager.isCollaborationActive())
		if (collaborativeManager.isCollaborationActive()) {
			if (!collaborativeManager.isPrimaryInstance()) {
				// Forward to primary instance
				console.log("[askResponse] Forwarding user response to primary instance")
				await collaborativeManager.processClineInput("user_response", {
					responseType: responseType,
					text: request.text,
					images: request.images,
					files: request.files,
					timestamp: Date.now(),
				})
				return Empty.create() // Don't process locally
			} else {
				console.log("[askResponse] Processing user response as primary instance")
			}
		}

		// Call the task's handler for webview responses
		await controller.task.handleWebviewAskResponse(responseType, request.text, request.images, request.files)

		// Sync state after response processing (primary only)
		if (collaborativeManager.isPrimaryInstance()) {
			await controller.syncStateToSecondaries()
		}

		return Empty.create()
	} catch (error) {
		console.error("Error in askResponse handler:", error)
		throw error
	}
}
