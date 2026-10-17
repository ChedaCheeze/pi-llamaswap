/**
 * pi-llamaswap — expose a llama-swap server as a Pi model provider.
 *
 * llama-swap's YAML is the single source of truth. This extension reads
 * GET {base}/models and turns every entry into a Pi chat model, using the
 * optional `metadata` block in the llama-swap config to declare thinking
 * behaviour. No models.json is needed on each machine.
 *
 * Install:
 *   pi install git:github.com/<you>/pi-llamaswap
 *
 * Configure (shell profile or export before running pi):
 *   export LLAMA_SWAP_URL=http://192.168.50.100:7000/v1
 *   export LLAMA_SWAP_KEY=sk-...        # optional; llama-swap apiKeys
 *
 * llama-swap config side, per model:
 *   name: "Qwen3.8-27B (Q4_K_XL, 196k)"
 *   metadata:
 *     reasoning: true
 *     maxTokens: 16384
 *     thinkingFormat: "chat-template"
 *     thinkingLevelMap: { medium: "medium", xhigh: "xhigh" }
 *     chatTemplateKwargs:
 *       enable_thinking: { "$var": "thinking.enabled" }
 *       reasoning_effort: { "$var": "thinking.effort", "omitWhenOff": true }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SwapModel {
	id: string;
	name?: string;
	description?: string;
	owned_by?: string;
	context_length?: number;
	context_window?: number;
	architecture?: { input_modalities?: string[]; output_modalities?: string[] };
	capabilities?: { function_calling?: boolean };
	status?: { value?: string };
	// llama-swap merges the config `metadata` block into meta.llamaswap.
	meta?: { llamaswap?: Record<string, unknown>; n_ctx?: number };
}

interface ModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	description?: string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:7000/v1";
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_CONTEXT_WINDOW = 32768;

function normalizeBaseUrl(raw: string): string {
	const url = new URL(raw.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("LLAMA_SWAP_URL must use http or https");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (!url.pathname.endsWith("/v1")) url.pathname = `${url.pathname}/v1`;
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

function toNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toModelConfig(model: SwapModel, byId: Map<string, SwapModel>): ModelConfig {
	const metadata = model.meta?.llamaswap ?? {};

	// Alias entries do not carry a discovered context length; borrow the parent's.
	let context = model.context_length ?? model.context_window ?? metadata.context ?? 0;
	if (!context) {
		const parentId = metadata.modelID;
		const parent = parentId ? byId.get(String(parentId)) : undefined;
		context = parent?.context_length ?? parent?.context_window ?? parent?.meta?.llamaswap?.context ?? 0;
	}
	if (!context) context = metadata.n_ctx ?? model.meta?.n_ctx ?? DEFAULT_CONTEXT_WINDOW;

	const input = (model.architecture?.input_modalities ?? ["text"])
		.filter((modality) => modality === "text" || modality === "image");
	if (input.length === 0) input.push("text");

	const config: ModelConfig = {
		id: model.id,
		name: model.name || model.description || model.id,
		// llama-swap cannot report this; assume reasoning-capable unless told otherwise.
		reasoning: metadata.reasoning !== false,
		input: input as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: toNumber(context, DEFAULT_CONTEXT_WINDOW),
		maxTokens: toNumber(metadata.maxTokens, DEFAULT_MAX_TOKENS),
	};

	if (metadata.thinkingLevelMap && typeof metadata.thinkingLevelMap === "object") {
		config.thinkingLevelMap = metadata.thinkingLevelMap as Record<string, string | null>;
	}

	const compat: Record<string, unknown> = {};
	if (typeof metadata.thinkingFormat === "string") compat.thinkingFormat = metadata.thinkingFormat;
	if (metadata.chatTemplateKwargs) compat.chatTemplateKwargs = metadata.chatTemplateKwargs;
	if (metadata.chatTemplateArgs) compat.chatTemplateArgs = metadata.chatTemplateArgs;
	if (typeof metadata.supportsReasoningEffort === "boolean") compat.supportsReasoningEffort = metadata.supportsReasoningEffort;
	if (typeof metadata.supportsStrictMode === "boolean") compat.supportsStrictMode = metadata.supportsStrictMode;
	if (typeof metadata.supportsDeveloperRole === "boolean") compat.supportsDeveloperRole = metadata.supportsDeveloperRole;
	if (typeof metadata.maxTokensField === "string") compat.maxTokensField = metadata.maxTokensField;
	if (Object.keys(compat).length > 0) config.compat = compat;

	return config;
}

function buildModelConfigs(models: SwapModel[]): ModelConfig[] {
	const byId = new Map<string, SwapModel>();
	for (const model of models) if (model.id && !byId.has(model.id)) byId.set(model.id, model);
	return [...byId.values()].map((model) => toModelConfig(model, byId));
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = normalizeBaseUrl(process.env.LLAMA_SWAP_URL ?? DEFAULT_BASE_URL);
	// No key fallback: an invented key produces a bare 401 with no hint. Without a
	// key we send no Authorization header, which still works when llama-swap has
	// no apiKeys configured.
	const apiKey = process.env.LLAMA_SWAP_KEY;
	if (!apiKey) {
		console.warn(
			"pi-llamaswap: LLAMA_SWAP_KEY is not set, requesting without an Authorization header. " +
			"This only works if llama-swap has no apiKeys configured.",
		);
	}
	const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

	const fetchModels = async (signal?: AbortSignal): Promise<SwapModel[]> => {
		const response = await fetch(`${baseUrl}/models`, { headers: authHeaders, signal });
		if (!response.ok) {
			const hint = response.status === 401 ? (apiKey ? "check LLAMA_SWAP_KEY" : "LLAMA_SWAP_KEY is unset") : "";
			throw new Error(`llama-swap returned HTTP ${response.status} from ${baseUrl}/models${hint ? ` (${hint})` : ""}`);
		}
		const payload = (await response.json()) as { data?: SwapModel[] };
		return payload.data ?? [];
	};

	// Fetch at load time so the models are present in /model and --list-models
	// without waiting for a catalog refresh. Pi waits for an async factory.
	// Returning an empty list from refreshModels replaces the catalog, so we
	// always return the last known good list rather than wiping it.
	let cachedModels: ModelConfig[] = [];
	try {
		cachedModels = buildModelConfigs(await fetchModels());
	} catch (error) {
		console.error(`pi-llamaswap: ${(error as Error).message}`);
	}

	pi.registerProvider("llamaswap", {
		name: "llama-swap",
		baseUrl,
		...(apiKey ? { apiKey } : {}),
		api: "openai-completions",
		models: cachedModels,
		async refreshModels(context) {
			if (!context.allowNetwork) return cachedModels;
			try {
				const models = await fetchModels(context.signal);
				cachedModels = buildModelConfigs(models);
				return cachedModels;
			} catch (error) {
				console.error(`pi-llamaswap: ${(error as Error).message}`);
				return cachedModels;
			}
		},
	});

	pi.registerCommand("llamaswap", {
		description: "Show llama-swap models and their load state",
		handler: async (_args, ctx) => {
			try {
				const models = await fetchModels(ctx.signal);
				if (models.length === 0) {
					ctx.ui.notify(`No models found at ${baseUrl}`, "warning");
					return;
				}
				const lines = models.map((model) => {
					const state = model.status?.value ?? "unknown";
					const ctxLen = model.context_length ?? model.context_window ?? 0;
					return `${state.padEnd(9)}  ${model.id}  (${ctxLen} ctx)`;
				});
				ctx.ui.notify(`${baseUrl}\n${lines.join("\n")}`, "info");
			} catch (error) {
				ctx.ui.notify(`llama-swap unreachable: ${(error as Error).message}`, "error");
			}
		},
	});
}
