import { Anthropic } from "@anthropic-ai/sdk"
import { ApiHandler } from "../index"
import { ApiStream } from "../transform/stream"

interface ProxyHandlerOptions {
	proxyUrl?: string
	roomId?: string
	authToken?: string
}

export class ProxyHandler implements ApiHandler {
	private proxyUrl: string
	private roomId?: string
	private authToken?: string

	constructor(options: ProxyHandlerOptions) {
		this.proxyUrl = options.proxyUrl || "http://management-server:5000/api/llm/chat"
		this.roomId = options.roomId
		this.authToken = options.authToken
	}

	/**
	 * Get auth token from environment or storage
	 */
	private getAuthToken(): string {
		// Try to get auth token from various sources
		if (this.authToken) {
			return this.authToken
		}

		// In interview container, use environment variable
		if (process.env.CODEWEAVER_AUTH_TOKEN) {
			return process.env.CODEWEAVER_AUTH_TOKEN
		}

		// No fallback - authentication token is required
		throw new Error("Authentication token is required. Set BLAZER_AUTH_TOKEN environment variable.")
	}

	/**
	 * Get room ID from environment or configuration
	 */
	private getRoomId(): string {
		if (this.roomId) {
			return this.roomId
		}

		// Get from environment variable set in interview container
		if (process.env.ROOM_ID) {
			return process.env.ROOM_ID
		}

		// Fallback
		return "default-room"
	}

	/**
	 * Parse Server-Sent Events stream and transform to Cline format
	 */
	private async *parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<any> {
		const reader = stream.getReader()
		const decoder = new TextDecoder()
		let buffer = ""

		try {
			while (true) {
				const { done, value } = await reader.read()

				if (done) {
					break
				}

				buffer += decoder.decode(value, { stream: true })

				// Process complete lines
				const lines = buffer.split("\n")
				buffer = lines.pop() || "" // Keep incomplete line in buffer

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const dataStr = line.slice(6) // Remove 'data: '

						if (dataStr.trim() === "") {
							continue // Skip empty data
						}

						try {
							const data = JSON.parse(dataStr)

							// Skip ping messages
							if (data.type === "ping") {
								continue
							}

							// Handle error messages
							if (data.type === "error") {
								throw new Error(data.error)
							}

							// Transform Anthropic format to Cline format
							if (data.type === "content_block_delta" && data.delta?.text) {
								yield {
									type: "text",
									text: data.delta.text,
								}
							}
							// Skip message_stop as Cline doesn't need it
							else if (data.type === "message_stop") {
								continue
							}
							// Pass through other types as-is
							else {
								yield data
							}
						} catch (parseError) {
							console.warn("Failed to parse SSE data:", dataStr, parseError)
						}
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const authToken = this.getAuthToken()
		const roomId = this.getRoomId()

		try {
			const response = await fetch(this.proxyUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${authToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"Cache-Control": "no-cache",
				},
				body: JSON.stringify({
					roomId: roomId,
					sessionId: null, // Will be populated by management server if needed
					messages: messages,
					systemPrompt: systemPrompt,
				}),
			})

			if (!response.ok) {
				const errorText = await response.text()
				let errorData
				try {
					errorData = JSON.parse(errorText)
				} catch {
					errorData = { error: errorText }
				}

				throw new Error(
					`LLM Proxy request failed: ${response.status} ${response.statusText}. ${errorData.error || errorText}`,
				)
			}

			if (!response.body) {
				throw new Error("No response body received from LLM proxy")
			}

			// Parse and yield the SSE stream
			yield* this.parseSSEStream(response.body)
		} catch (error) {
			console.error("Proxy handler error:", error)
			throw error
		}
	}

	getModel(): { id: string; info: any } {
		return {
			id: "gemini-2.5-flash",
			info: {
				maxTokens: 8192,
				contextWindow: 1048576, // 1M tokens
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 0.075, // $0.075 per 1M input tokens
				outputPrice: 0.3, // $0.30 per 1M output tokens
				description: "Google Gemini 2.5 Flash via Blazer Proxy",
			},
		}
	}

	async getApiStreamUsage?(): Promise<any> {
		// Usage tracking is handled by the proxy service
		return undefined
	}
}
