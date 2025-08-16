import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useState } from "react"
import { useInterval } from "react-use"
import styled from "styled-components"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "./OpenRouterModelPicker"
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { ClineProvider } from "./providers/ClineProvider"
import { OpenRouterProvider } from "./providers/OpenRouterProvider"
import { MistralProvider } from "./providers/MistralProvider"
import { DeepSeekProvider } from "./providers/DeepSeekProvider"
import { TogetherProvider } from "./providers/TogetherProvider"
import { OpenAICompatibleProvider } from "./providers/OpenAICompatible"
import { SambanovaProvider } from "./providers/SambanovaProvider"
import { AnthropicProvider } from "./providers/AnthropicProvider"
import { AskSageProvider } from "./providers/AskSageProvider"
import { OpenAINativeProvider } from "./providers/OpenAINative"
import { GeminiProvider } from "./providers/GeminiProvider"
import { DoubaoProvider } from "./providers/DoubaoProvider"
import { QwenProvider } from "./providers/QwenProvider"
import { VertexProvider } from "./providers/VertexProvider"
import { RequestyProvider } from "./providers/RequestyProvider"
import { FireworksProvider } from "./providers/FireworksProvider"
import { XaiProvider } from "./providers/XaiProvider"
import { CerebrasProvider } from "./providers/CerebrasProvider"
import { OllamaProvider } from "./providers/OllamaProvider"
import { ClaudeCodeProvider } from "./providers/ClaudeCodeProvider"
import { SapAiCoreProvider } from "./providers/SapAiCoreProvider"
import { BedrockProvider } from "./providers/BedrockProvider"
import { MoonshotProvider } from "./providers/MoonshotProvider"
import { HuggingFaceProvider } from "./providers/HuggingFaceProvider"
import { NebiusProvider } from "./providers/NebiusProvider"
import { LiteLlmProvider } from "./providers/LiteLlmProvider"
import { VSCodeLmProvider } from "./providers/VSCodeLmProvider"
import { LMStudioProvider } from "./providers/LMStudioProvider"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"
import { GroqProvider } from "./providers/GroqProvider"
import { BasetenProvider } from "./providers/BasetenProvider"
import { Mode } from "@shared/storage/types"
import { HuaweiCloudMaasProvider } from "./providers/HuaweiCloudMaasProvider"

interface ApiOptionsProps {
	showModelOptions: boolean
	apiErrorMessage?: string
	modelIdErrorMessage?: string
	isPopup?: boolean
	currentMode: Mode
}

// This is necessary to ensure dropdown opens downward, important for when this is used in popup
export const DROPDOWN_Z_INDEX = OPENROUTER_MODEL_PICKER_Z_INDEX + 2 // Higher than the OpenRouterModelPicker's and ModelSelectorTooltip's z-index

export const DropdownContainer = styled.div<{ zIndex?: number }>`
	position: relative;
	z-index: ${(props) => props.zIndex || DROPDOWN_Z_INDEX};

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

declare module "vscode" {
	interface LanguageModelChatSelector {
		vendor?: string
		family?: string
		version?: string
		id?: string
	}
}

const ApiOptions = ({ showModelOptions, apiErrorMessage, modelIdErrorMessage, isPopup, currentMode }: ApiOptionsProps) => {
	// Use full context state for immediate save payload
	const { apiConfiguration } = useExtensionState()

	const { selectedProvider } = normalizeApiConfiguration(apiConfiguration, currentMode)

	const { handleModeFieldChange } = useApiConfigurationHandlers()

	// Check if we're in interview mode (settings locked)
	const isInterviewMode = apiConfiguration?.settingsLocked === true
	const isProxyMode = selectedProvider === "proxy"

	const [ollamaModels, setOllamaModels] = useState<string[]>([])

	// Poll ollama/vscode-lm models
	const requestLocalModels = useCallback(async () => {
		if (selectedProvider === "ollama") {
			try {
				const response = await ModelsServiceClient.getOllamaModels(
					StringRequest.create({
						value: apiConfiguration?.ollamaBaseUrl || "",
					}),
				)
				if (response && response.values) {
					setOllamaModels(response.values)
				}
			} catch (error) {
				console.error("Failed to fetch Ollama models:", error)
				setOllamaModels([])
			}
		}
	}, [selectedProvider, apiConfiguration?.ollamaBaseUrl])
	useEffect(() => {
		if (selectedProvider === "ollama") {
			requestLocalModels()
		}
	}, [selectedProvider, requestLocalModels])
	useInterval(requestLocalModels, selectedProvider === "ollama" ? 2000 : null)

	/*
	VSCodeDropdown has an open bug where dynamically rendered options don't auto select the provided value prop. You can see this for yourself by comparing  it with normal select/option elements, which work as expected.
	https://github.com/microsoft/vscode-webview-ui-toolkit/issues/433

	In our case, when the user switches between providers, we recalculate the selectedModelId depending on the provider, the default model for that provider, and a modelId that the user may have selected. Unfortunately, the VSCodeDropdown component wouldn't select this calculated value, and would default to the first "Select a model..." option instead, which makes it seem like the model was cleared out when it wasn't.

	As a workaround, we create separate instances of the dropdown for each provider, and then conditionally render the one that matches the current provider.
	*/

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: isPopup ? -10 : 0 }}>
			<DropdownContainer className="dropdown-container">
				<label htmlFor="api-provider">
					<span style={{ fontWeight: 500 }}>API Provider</span>
					{isInterviewMode && (
						<span
							style={{
								marginLeft: 8,
								fontSize: "0.8em",
								color: "var(--vscode-charts-orange)",
								fontWeight: "normal",
							}}>
							(Managed by Interview Environment)
						</span>
					)}
				</label>
				<VSCodeDropdown
					id="api-provider"
					value={selectedProvider}
					disabled={isInterviewMode}
					onChange={(e: any) => {
						if (!isInterviewMode) {
							handleModeFieldChange(
								{ plan: "planModeApiProvider", act: "actModeApiProvider" },
								e.target.value,
								currentMode,
							)
						}
					}}
					style={{
						minWidth: 130,
						position: "relative",
						opacity: isInterviewMode ? 0.7 : 1,
					}}>
					{isProxyMode ? (
						<VSCodeOption value="proxy">CodeWeaver Proxy (Gemini 2.5 Flash)</VSCodeOption>
					) : (
						<>
							<VSCodeOption value="cline">Cline</VSCodeOption>
							<VSCodeOption value="openrouter">OpenRouter</VSCodeOption>
							<VSCodeOption value="anthropic">Anthropic</VSCodeOption>
							<VSCodeOption value="claude-code">Claude Code</VSCodeOption>
							<VSCodeOption value="bedrock">Amazon Bedrock</VSCodeOption>
							<VSCodeOption value="openai">OpenAI Compatible</VSCodeOption>
							<VSCodeOption value="vertex">GCP Vertex AI</VSCodeOption>
							<VSCodeOption value="gemini">Google Gemini</VSCodeOption>
							<VSCodeOption value="groq">Groq</VSCodeOption>
							<VSCodeOption value="deepseek">DeepSeek</VSCodeOption>
							<VSCodeOption value="openai-native">OpenAI</VSCodeOption>
							<VSCodeOption value="cerebras">Cerebras</VSCodeOption>
							<VSCodeOption value="baseten">Baseten</VSCodeOption>
							<VSCodeOption value="vscode-lm">VS Code LM API</VSCodeOption>
							<VSCodeOption value="mistral">Mistral</VSCodeOption>
							<VSCodeOption value="requesty">Requesty</VSCodeOption>
							<VSCodeOption value="fireworks">Fireworks</VSCodeOption>
							<VSCodeOption value="together">Together</VSCodeOption>
							<VSCodeOption value="qwen">Alibaba Qwen</VSCodeOption>
							<VSCodeOption value="doubao">Bytedance Doubao</VSCodeOption>
							<VSCodeOption value="lmstudio">LM Studio</VSCodeOption>
							<VSCodeOption value="ollama">Ollama</VSCodeOption>
							<VSCodeOption value="litellm">LiteLLM</VSCodeOption>
							<VSCodeOption value="moonshot">Moonshot</VSCodeOption>
							<VSCodeOption value="huggingface">Hugging Face</VSCodeOption>
							<VSCodeOption value="nebius">Nebius AI Studio</VSCodeOption>
							<VSCodeOption value="asksage">AskSage</VSCodeOption>
							<VSCodeOption value="xai">xAI</VSCodeOption>
							<VSCodeOption value="sambanova">SambaNova</VSCodeOption>
							<VSCodeOption value="sapaicore">SAP AI Core</VSCodeOption>
							<VSCodeOption value="huawei-cloud-maas">Huawei Cloud MaaS</VSCodeOption>
						</>
					)}
				</VSCodeDropdown>
			</DropdownContainer>

			{apiConfiguration && selectedProvider === "cline" && !isProxyMode && (
				<ClineProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "asksage" && !isProxyMode && (
				<AskSageProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "anthropic" && !isProxyMode && (
				<AnthropicProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "claude-code" && !isProxyMode && (
				<ClaudeCodeProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "openai-native" && !isProxyMode && (
				<OpenAINativeProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "qwen" && !isProxyMode && (
				<QwenProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "doubao" && !isProxyMode && (
				<DoubaoProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "mistral" && !isProxyMode && (
				<MistralProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "openrouter" && !isProxyMode && (
				<OpenRouterProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "deepseek" && !isProxyMode && (
				<DeepSeekProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "together" && !isProxyMode && (
				<TogetherProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "openai" && !isProxyMode && (
				<OpenAICompatibleProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "sambanova" && !isProxyMode && (
				<SambanovaProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "bedrock" && !isProxyMode && (
				<BedrockProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "vertex" && !isProxyMode && (
				<VertexProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "gemini" && !isProxyMode && (
				<GeminiProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "requesty" && !isProxyMode && (
				<RequestyProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "fireworks" && !isProxyMode && (
				<FireworksProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "vscode-lm" && !isProxyMode && (
				<VSCodeLmProvider currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "groq" && !isProxyMode && (
				<GroqProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}
			{apiConfiguration && selectedProvider === "baseten" && !isProxyMode && (
				<BasetenProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}
			{apiConfiguration && selectedProvider === "litellm" && !isProxyMode && (
				<LiteLlmProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "lmstudio" && !isProxyMode && (
				<LMStudioProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "ollama" && !isProxyMode && (
				<OllamaProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "moonshot" && !isProxyMode && (
				<MoonshotProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "huggingface" && !isProxyMode && (
				<HuggingFaceProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "nebius" && !isProxyMode && (
				<NebiusProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "xai" && !isProxyMode && (
				<XaiProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "cerebras" && !isProxyMode && (
				<CerebrasProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "sapaicore" && !isProxyMode && (
				<SapAiCoreProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{apiConfiguration && selectedProvider === "huawei-cloud-maas" && !isProxyMode && (
				<HuaweiCloudMaasProvider showModelOptions={showModelOptions} isPopup={isPopup} currentMode={currentMode} />
			)}

			{isProxyMode && (
				<div
					style={{
						padding: 12,
						backgroundColor: "var(--vscode-editor-inactiveSelectionBackground)",
						border: "1px solid var(--vscode-widget-border)",
						borderRadius: 4,
						marginTop: 8,
					}}>
					<div style={{ fontWeight: 500, marginBottom: 4, color: "var(--vscode-charts-green)" }}>
						🔒 Secure Interview Mode
					</div>
					<div style={{ fontSize: "0.9em", color: "var(--vscode-foreground)", opacity: 0.8 }}>
						LLM requests are routed through CodeWeaver's secure proxy using Gemini 2.5 Flash. API configuration is
						managed by the interview environment.
					</div>
				</div>
			)}

			{apiErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{apiErrorMessage}
				</p>
			)}
			{modelIdErrorMessage && (
				<p
					style={{
						margin: "-10px 0 4px 0",
						fontSize: 12,
						color: "var(--vscode-errorForeground)",
					}}>
					{modelIdErrorMessage}
				</p>
			)}
		</div>
	)
}

export default ApiOptions
