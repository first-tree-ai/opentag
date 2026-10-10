# Cloud Pi image input

Cloud Pi's disposable custom model must declare `input: ["text", "image"]` for a verified image-capable model.
Pi 0.84.2 defaults custom models without `input` to `["text"]`; its native `read` tool then reports that images will
be omitted, and its OpenAI-compatible adapter excludes them from the model request.

## Capability evidence

The Router model list and existing execution grant carry exact model IDs, context windows and output budgets, but no
input modalities. The Runner therefore uses a small, explicit capability snapshot for exact IDs already admitted by
the Server. It does not use model-family prefixes, aliases, regexes, or a blanket image default. This snapshot cannot
authorize a model: the Server catalog and the execution token still control which model can execute.

Verified on 2026-10-10:

| Exact Cloud model IDs | Evidence for text and image input |
| --- | --- |
| `gemini-3.8-flash` | [Google model specification](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| `gemini-3.1-flash-lite` | Pi 0.84.2 bundled `google` and `google-vertex` model metadata: `input: ["text", "image"]` |
| `glm-5.3-flash` | Pi 0.84.2 bundled `zai` model metadata: `input: ["text", "image"]` |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Pi 0.84.2 bundled `openai` model metadata: `input: ["text", "image"]` |
| `gpt-6-astra` | [OpenAI model comparison](https://developers.openai.com/api/docs/models/compare) |
| `gpt-6-sol`, `gpt-6-luna` | [OpenAI changelog, 2026-09-22](https://developers.openai.com/api/docs/changelog) |
| `claude-opus-5`, `claude-sonnet-5` | Pi 0.84.2 bundled `anthropic` model metadata: `input: ["text", "image"]` |
| `claude-fable-5.1`, `claude-opus-5.5` | [Anthropic model overview](https://platform.claude.com/docs/en/models/overview) |
| `kimi-k3` | Pi 0.84.2 bundled `moonshotai` model metadata: `input: ["text", "image"]` |
| `deepseek-v4.1-flash` | [DeepSeek V4.1 Flash release](https://api-docs.deepseek.com/news/news260910/) |

The Pi metadata comes from its locked `@earendil-works/pi-ai` dependency's `dist/providers/data/*.json`.
`glm-5.3` is text-only in that snapshot; `glm-5.3-flashx` has no verified image declaration. Both retain `["text"]`.
Every unknown ID, including a new alias of a known model, also retains `["text"]` until verified. When adding a model,
verify its exact ID and upstream image support before updating this snapshot. If the Router later publishes verified
modalities, a separate compatible protocol change can replace this snapshot with Server-issued metadata.

## Behavior and verification boundary

IM ingress continues to provide text and native resource IDs. The Agent downloads and reads the original image only
when needed. This change adds no Server download, OCR, transcription, extraction, sampling, or preprocessing.
Pi retains its native image handling. Context windows, output budgets, credentials, proxy routes and grants are unchanged;
older grant documents remain valid, and pure-text requests continue to work.

`cloud-pi-image-input.test.ts` starts the locked real Pi CLI against a loopback model endpoint using the production
document generator and an existing-schema grant. It requests the native `read` tool, checks that the initial text
request has no image, and verifies that the next authenticated request contains the exact small PNG data URL for
Gemini 3.8 Flash. Text-only and unknown-model controls check that image parts remain absent and Pi reports omission.
The endpoint supplies deterministic tool calls and text: this proves transport, not a real provider's visual recognition.
Deployment and live Slack/Feishu recognition require separate acceptance evidence.
