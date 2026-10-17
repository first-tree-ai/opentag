# Cloud Pi image input: verification and acceptance

Test and acceptance material for [Cloud Pi image input](../../docs/system/cloud/cloud-pi-image-input.md).

## Verification boundary

`cloud-pi-image-input.test.ts` starts the locked real Pi CLI against a loopback model endpoint using the production
document generator and an existing-schema grant. It requests the native `read` tool, checks that the initial text
request has no image, and verifies that the next authenticated request contains the exact small PNG data URL for
Gemini 4 Argon and Gemini 3.8 Flash. Text-only and unknown-model controls check that image parts remain absent and Pi reports omission.
The endpoint supplies deterministic tool calls and text: this proves transport, not a real provider's visual recognition.
Deployment and live Slack/Feishu recognition require separate acceptance evidence.
