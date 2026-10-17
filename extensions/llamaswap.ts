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
 * First run:
 *   /llamaswap login      # prompts for the API key, validates it, stores it in auth.json
 *   /llamaswap            # show models, load state, and where the key came from
 *
 * Configure (optional; the key can also come from /llamaswap login):
 *   export LLAMA_SWAP_URL=http://192.168.50.100:7000/v1
 *   export LLAMA_SWAP_KEY=sk-...
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

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER_ID = "llamaswap";
const DEFAULT_BASE_URL = "http://127.0.0.1:7000/v1";
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_CONTEXT_WINDOW = 32768;

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
}

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

// Pi's agent directory: PI_CODING_AGENT_DIR, otherwise ~/.pi/agent.
function agentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (configured) return configured;
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	return join(home, ".pi", "agent");
}

function authPath(): string {
	return join(agentDir(), "auth.json");
}

// Read the key Pi already has for this provider. An api-key entry in auth.json
// is { type: "api_key", key: "..." }. `!command` keys are not executed here.
function readStoredKey(): string | undefined {
	const path = authPath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const entry = raw?.[PROVIDER_ID];
		if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
			const key = (entry as { key: string }).key.trim();
			if (key && !key.startsWith("!")) return key;
		}
	} catch {
		// Unreadable or malformed auth.json: treat as no stored key.
	}
	return undefined;
}

// Read-modify-write so other providers in auth.json are preserved. Written to a
// temp file and renamed, so a failure mid-write cannot truncate the file.
function writeStoredKey(key: string | null): void {
	const path = authPath();
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
	}

	if (key) existing[PROVIDER_ID] = { type: "api_key", key };
	else delete existing[PROVIDER_ID];

	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

export default async function (pi: ExtensionAPI) {
	const baseUrl = normalizeBaseUrl(process.env.LLAMA_SWAP_URL ?? DEFAULT_BASE_URL);

	// Key resolution order: environment, then Pi's auth.json. No placeholder key:
	// an invented key produces a bare 401 with no hint. With no key at all we send
	// no Authorization header, which works when llama-swap has no apiKeys.
	let apiKey = process.env.LLAMA_SWAP_KEY?.trim() || undefined;
	let keySource = apiKey ? "env LLAMA_SWAP_KEY" : undefined;
	if (!apiKey) {
		apiKey = readStoredKey();
		if (apiKey) keySource = authPath();
	}

	let cachedModels: ModelConfig[] = [];

	const fetchModels = async (key: string | undefined, signal?: AbortSignal): Promise<SwapModel[]> => {
		const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
		const response = await fetch(`${baseUrl}/models`, { headers, signal });
		if (!response.ok) {
			const hint =
				response.status === 401
					? key
						? "the key was rejected, run /llamaswap login"
						: "no key configured, run /llamaswap login"
					: "";
			throw new Error(`llama-swap returned HTTP ${response.status} from ${baseUrl}/models${hint ? ` (${hint})` : ""}`);
		}
		const payload = (await response.json()) as { data?: SwapModel[] };
		return payload.data ?? [];
	};

	const register = (models: ModelConfig[]) => {
		pi.registerProvider(PROVIDER_ID, {
			name: "llama-swap",
			baseUrl,
			...(apiKey ? { apiKey } : {}),
			api: "openai-completions",
			models,
			async refreshModels(context) {
				// Prefer the credential Pi resolved (auth.json wins over env).
				const credentialKey = typeof context.credential?.key === "string" ? context.credential.key : apiKey;
				if (!context.allowNetwork) return cachedModels;
				try {
					cachedModels = buildModelConfigs(await fetchModels(credentialKey, context.signal));
					return cachedModels;
				} catch (error) {
					console.error(`pi-llamaswap: ${(error as Error).message}`);
					return cachedModels;
				}
			},
		});
	};

	// Fetch at load time so the models are present in /model and --list-models
	// without waiting for a catalog refresh. Pi waits for an async factory.
	// Returning an empty list from refreshModels replaces the catalog, so we
	// always return the last known good list rather than wiping it.
	try {
		cachedModels = buildModelConfigs(await fetchModels(apiKey));
	} catch (error) {
		console.error(`pi-llamaswap: ${(error as Error).message}`);
		if (!apiKey) console.error("pi-llamaswap: run /llamaswap login to store an API key.");
	}

	register(cachedModels);

	pi.registerCommand("llamaswap", {
		description: "llama-swap models, load state, and API key management (login/logout)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "login") {
				let key = parts.slice(1).join(" ").trim();
				if (!key) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Usage: /llamaswap login <key>", "error");
						return;
					}
					key = (await ctx.ui.input("llama-swap API key", "sk-..."))?.trim() ?? "";
				}
				if (!key) {
					ctx.ui.notify("No key entered, nothing saved.", "warning");
					return;
				}
				try {
					const models = buildModelConfigs(await fetchModels(key));
					writeStoredKey(key);
					apiKey = key;
					keySource = authPath();
					cachedModels = models;
					register(models);
					ctx.ui.notify(
						`Key accepted. ${models.length} model(s) from ${baseUrl}. Saved to ${authPath()}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Key not saved: ${(error as Error).message}`, "error");
				}
				return;
			}

			if (sub === "logout") {
				writeStoredKey(null);
				apiKey = undefined;
				keySource = undefined;
				register(cachedModels);
				ctx.ui.notify(`Removed the llama-swap key from ${authPath()}`, "info");
				return;
			}

			const lines = [
				`endpoint: ${baseUrl}`,
				`key: ${apiKey ? `from ${keySource}` : "not set — run /llamaswap login"}`,
			];
			try {
				const models = await fetchModels(apiKey, ctx.signal);
				if (models.length === 0) {
					ctx.ui.notify(`${lines.join("\n")}\nNo models found.`, "warning");
					return;
				}
				for (const model of models) {
					const state = model.status?.value ?? "unknown";
					const ctxLen = model.context_length ?? model.context_window ?? 0;
					lines.push(`${state.padEnd(9)}  ${model.id}  (${ctxLen} ctx)`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				ctx.ui.notify(`${lines.join("\n")}\n${(error as Error).message}`, "error");
			}
		},
	});
}
