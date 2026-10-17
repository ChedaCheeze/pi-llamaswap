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

## Configure

```bash
export LLAMA_SWAP_URL=http://192.168.50.100:7000/v1   # default http://127.0.0.1:7000/v1
export LLAMA_SWAP_KEY=sk-...                          # required if the server has apiKeys
```

Then `/model` lists everything the swap knows about. `/llamaswap` prints each
model's load state and context size.

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

## Gotcha

Pi's `refreshModels` contract replaces the provider's catalog with whatever you
return. Returning `[]` (for example when the swap is unreachable) **empties the
model list**. The extension keeps a cached list and returns that on failure.

## Credentials

If `LLAMA_SWAP_KEY` is not set, the extension warns at load and sends no
`Authorization` header. That works when the server has no `apiKeys`; against an
authenticated server it 401s, and the error message says to set the variable.

Note: Pi resolves credentials from `~/.pi/agent/auth.json` **before** shell
environment variables, so for Pi's built-in providers the key must be in
`auth.json` (or in `models.json` as `apiKey`). This extension reads
`LLAMA_SWAP_KEY` directly.

## Files

```text
pi-llamaswap/
├── package.json
├── README.md
└── extensions/llamaswap.ts
```
