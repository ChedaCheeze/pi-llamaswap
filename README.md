# pi-llamaswap

Registers a [llama-swap](https://github.com/mostlygeek/llama-swap) server as a Pi
model provider. Models are discovered from `GET {base}/models`, so llama-swap's
YAML stays the single source of truth — no `models.json` per machine.

## Why

Pi's built-in `llama.cpp` provider is written for llama.cpp's **router** mode. It
filters the model list to models that are already `loaded`/`sleeping` (or
`source: "preset"` with router autoload). llama-swap reports `unloaded` with no
`source` and has no `/props`, so Pi sees nothing or only the currently resident
model. This extension registers a plain `openai-completions` provider instead.

## Install

```bash
pi install git:github.com/<you>/pi-llamaswap
```

Or try it without installing:

```bash
pi -e ./extensions/llamaswap.ts
```

## First run

```
/llamaswap login          # prompts for the API key
/llamaswap login sk-...   # non-interactive form
```

The key is validated against the server before it is saved — a typo is never
written to disk. It is stored in `<agent-dir>/auth.json` (normally
`~/.pi/agent/auth.json`) under the `llamaswap` provider, which is where Pi keeps
credentials, so every later session picks it up with no environment setup:

```json
{
  "llamaswap": { "type": "api_key", "key": "sk-..." }
}
```

`/llamaswap logout` removes that entry.

## Configure

Both are optional; the key can come from `/llamaswap login` instead.

```bash
export LLAMA_SWAP_URL=http://192.168.50.100:7000/v1   # default http://127.0.0.1:7000/v1
export LLAMA_SWAP_KEY=sk-...                          # optional, see below
```

Resolution order: `LLAMA_SWAP_KEY`, then `auth.json`. If neither exists the
extension sends no `Authorization` header, which works only when llama-swap has
no `apiKeys` configured.

`/llamaswap` prints the endpoint, where the key came from, and each model's load
state and context size.

Note: Pi resolves provider credentials from `auth.json` **before** shell
environment variables, so once `/llamaswap login` has run the env var is no
longer needed.

## Declaring thinking behaviour

llama-swap cannot report whether a model thinks, so put it in the model's
`metadata` block — llama-swap passes it through verbatim in `/v1/models`:

```yaml
models:
  "unsloth/Qwen3.8-27B-GGUF:Q4_K_XL":
    name: "Qwen3.8-27B (Q4_K_XL, 196k)"
    metadata:
      reasoning: true
      maxTokens: 16384
      thinkingFormat: "chat-template"
      thinkingLevelMap:
        minimal: "low"
        low: "low"
        medium: "medium"
        high: "high"
        xhigh: "xhigh"
      chatTemplateKwargs:
        enable_thinking: { "$var": "thinking.enabled" }
        reasoning_effort: { "$var": "thinking.effort", "omitWhenOff": true }

  strata-q2:
    metadata:
      reasoning: true
      maxTokens: 16384
      supportsReasoningEffort: true
      thinkingLevelMap:
        off: "none"
        minimal: "low"
        low: "low"
        medium: "medium"
        high: "high"
        xhigh: "high"
```

Recognised `metadata` keys: `reasoning`, `maxTokens`, `context`, `thinkingFormat`,
`thinkingLevelMap`, `chatTemplateKwargs`, `chatTemplateArgs`,
`supportsReasoningEffort`, `supportsStrictMode`, `supportsDeveloperRole`,
`maxTokensField`.

Note: llama-swap merges `metadata` into `meta.llamaswap` in the API response rather
than echoing it as a `metadata` field. Also, `context_length` is only reported once
a model has actually been loaded, so set `context` here to make the window correct
while the model is unloaded.

Defaults when `metadata` is absent: `reasoning: true`, `maxTokens: 16384`,
`contextWindow` from `context_length`, no thinking format (so `/thinking` has no
effect on that model).

## Gotchas

- Pi's `refreshModels` contract replaces the provider's catalog with whatever you
  return. Returning `[]` (for example when the swap is unreachable) **empties the
  model list**. The extension keeps a cached list and returns that on failure.
- The extension writes `auth.json` directly. Pi has no extension-facing credential
  write API, so this is a read-modify-write of the file (temp file + rename, mode
  600) rather than Pi's own locked write path. Other providers in the file are
  preserved.

## Files

```text
pi-llamaswap/
├── package.json
├── README.md
└── extensions/llamaswap.ts
```
