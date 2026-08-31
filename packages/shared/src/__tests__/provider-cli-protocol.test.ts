import { describe, expect, it } from "vitest";
import {
  ClientRuntimeBusinessFrameSchema,
  missingRuntimeCapabilities,
  negotiateRuntimeCapabilities,
  ProviderCliArtifactStatusFrameSchema,
  ProviderCliCancelFrameSchema,
  ProviderCliRequirementFrameSchema,
  ProviderCliValidationGrantFrameSchema,
  ProviderCliValidationResultFrameSchema,
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_OFFERS,
  RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  ServerRuntimeBusinessFrameSchema,
} from "../index.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const requirementRequestId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";

const slackIdentity = {
  provider: "slack" as const,
  teamId: "T1",
  botUserId: "U1",
  botId: "B1",
};

const requirement = {
  type: "provider-cli:requirement" as const,
  operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
  requestId,
  provider: "slack" as const,
  agentId,
  integrationId,
  credentialGeneration: 2,
  expectedIdentity: slackIdentity,
};

describe("provider CLI reconcile protocol", () => {
  it("negotiates the reconcile capability so old Clients never receive unknown frames", () => {
    expect(RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.providerCliReconcile]).toEqual({ min: 1, max: 1 });
    expect(RUNTIME_CLIENT_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.providerCliReconcile]).toEqual({ min: 1, max: 1 });
    expect(
      negotiateRuntimeCapabilities(RUNTIME_CLIENT_CAPABILITY_OFFERS, RUNTIME_SERVER_CAPABILITY_OFFERS)[
        RUNTIME_CAPABILITY.providerCliReconcile
      ],
    ).toBe(1);
    expect(
      missingRuntimeCapabilities(
        [RUNTIME_CAPABILITY.providerCliReconcile],
        negotiateRuntimeCapabilities(
          { [RUNTIME_CAPABILITY.imCredentialGrant]: { min: 1, max: 1 } },
          RUNTIME_SERVER_CAPABILITY_OFFERS,
        ),
      ),
    ).toEqual([RUNTIME_CAPABILITY.providerCliReconcile]);
  });

  it("accepts a secret-free requirement and rejects path, version, url, argv, and env", () => {
    expect(ServerRuntimeBusinessFrameSchema.parse(requirement)).toEqual(requirement);
    expect(ProviderCliRequirementFrameSchema.parse(requirement)).toEqual(requirement);
    for (const extra of [
      { path: "/usr/local/bin/slack" },
      { version: "4.7.0" },
      { url: "https://example.invalid/slack" },
      { argv: ["api", "auth.test"] },
      { env: { SLACK_BOT_TOKEN: "xoxb-secret" } },
      { botAccessToken: "xoxb-secret" },
    ]) {
      expect(() => ProviderCliRequirementFrameSchema.parse({ ...requirement, ...extra })).toThrow();
    }
    expect(() =>
      ProviderCliRequirementFrameSchema.parse({
        ...requirement,
        expectedIdentity: { ...slackIdentity, provider: "feishu", appId: "cli", botOpenId: "ou", teamBrand: "feishu" },
      }),
    ).toThrow();
  });

  it("accepts coarse artifact status on the Client business surface without local details", () => {
    const status = {
      type: "provider-cli:artifact:status" as const,
      requestId,
      provider: "slack" as const,
      agentId,
      integrationId,
      credentialGeneration: 2,
      status: "ready" as const,
    };
    expect(ProviderCliArtifactStatusFrameSchema.parse(status)).toEqual(status);
    expect(ClientRuntimeBusinessFrameSchema.parse(status)).toEqual(status);
    expect(() => ProviderCliArtifactStatusFrameSchema.parse({ ...status, fingerprint: "abc" })).toThrow();
    expect(() => ProviderCliArtifactStatusFrameSchema.parse({ ...status, path: "/bin/slack" })).toThrow();
    expect(() => ProviderCliArtifactStatusFrameSchema.parse({ ...status, status: "install" })).toThrow();
  });

  it("requires requirementRequestId on one-shot validation grants", () => {
    const grant = {
      type: "provider-cli:validation:grant" as const,
      requestId,
      requirementRequestId,
      provider: "slack" as const,
      agentId,
      integrationId,
      credentialGeneration: 2,
      expiresAt: "2026-08-31T00:00:15.000Z",
      expectedIdentity: slackIdentity,
      grant: { provider: "slack" as const, botAccessToken: "xoxb-test" },
    };
    expect(ProviderCliValidationGrantFrameSchema.parse(grant)).toEqual(grant);
    expect(ServerRuntimeBusinessFrameSchema.parse(grant)).toMatchObject({ type: "provider-cli:validation:grant" });
    expect(() => ProviderCliValidationGrantFrameSchema.parse({ ...grant, requirementRequestId: undefined })).toThrow();
    expect(() => ProviderCliValidationGrantFrameSchema.parse({ ...grant, sessionId: requestId })).toThrow();
    expect(() => ProviderCliValidationGrantFrameSchema.parse({ ...grant, argv: ["auth.test"] })).toThrow();
  });

  it("forbids checking on Client validation results and requires retry reasons", () => {
    const result = {
      type: "provider-cli:validation:result" as const,
      requestId,
      provider: "slack" as const,
      agentId,
      integrationId,
      credentialGeneration: 2,
      status: "needs_attention" as const,
    };
    expect(ProviderCliValidationResultFrameSchema.parse(result)).toEqual(result);
    expect(ClientRuntimeBusinessFrameSchema.parse(result)).toEqual(result);
    expect(
      ProviderCliValidationResultFrameSchema.parse({
        ...result,
        status: "retrying",
        reason: "artifact_changed",
      }),
    ).toMatchObject({ status: "retrying", reason: "artifact_changed" });
    expect(() => ProviderCliValidationResultFrameSchema.parse({ ...result, status: "checking" })).toThrow();
    expect(() =>
      ProviderCliValidationResultFrameSchema.parse({ ...result, status: "ready", reason: "identity_mismatch" }),
    ).toThrow();
    expect(() => ProviderCliValidationResultFrameSchema.parse({ ...result, status: "retrying" })).toThrow();
    expect(() =>
      ProviderCliValidationResultFrameSchema.parse({
        ...result,
        status: "retrying",
        reason: "credential_rejected",
      }),
    ).toThrow();
    expect(() =>
      ProviderCliValidationResultFrameSchema.parse({
        ...result,
        status: "needs_attention",
        reason: "validation_busy",
      }),
    ).toThrow();
    expect(() => ProviderCliValidationResultFrameSchema.parse({ ...result, stdout: "{}" })).toThrow();
  });

  it("defines a secret-free cancel frame fenced to the requirement", () => {
    const cancel = {
      type: "provider-cli:cancel" as const,
      requestId,
      requirementRequestId,
      provider: "slack" as const,
      agentId,
      integrationId,
      credentialGeneration: 2,
    };
    expect(ProviderCliCancelFrameSchema.parse(cancel)).toEqual(cancel);
    expect(ServerRuntimeBusinessFrameSchema.parse(cancel)).toMatchObject({ type: "provider-cli:cancel" });
    expect(() =>
      ProviderCliCancelFrameSchema.parse({ ...cancel, grant: { provider: "slack", botAccessToken: "x" } }),
    ).toThrow();
    expect(() => ProviderCliCancelFrameSchema.parse({ ...cancel, botAccessToken: "xoxb-test" })).toThrow();
  });
});
