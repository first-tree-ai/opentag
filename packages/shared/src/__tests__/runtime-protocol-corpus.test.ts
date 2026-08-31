import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentTraceBatchSchema,
  AuthFrameSchema,
  ComputerRegisterFrameSchema,
  DirectImMessageDeliveryRequestSchema,
  EffectiveRuntimeSnapshotSchema,
  HeartbeatFrameSchema,
  RuntimeErrorFrameSchema,
  RuntimeImCredentialGrantRequestSchema,
  RuntimeImCredentialGrantResultSchema,
  ServerWelcomeFrameSchema,
  SessionMessageDeliveryResultSchema,
  SessionReconcileRequestSchema,
} from "../index.js";

const corpus = JSON.parse(readFileSync(new URL("./runtime-protocol-corpus.json", import.meta.url), "utf8")) as Array<{
  name: string;
  schema: string;
  payload: unknown;
}>;

const schemas = {
  AgentTraceBatchSchema,
  AuthFrameSchema,
  ComputerRegisterFrameSchema,
  DirectImMessageDeliveryRequestSchema,
  EffectiveRuntimeSnapshotSchema,
  HeartbeatFrameSchema,
  RuntimeErrorFrameSchema,
  RuntimeImCredentialGrantRequestSchema,
  RuntimeImCredentialGrantResultSchema,
  ServerWelcomeFrameSchema,
  SessionMessageDeliveryResultSchema,
  SessionReconcileRequestSchema,
} as const;

describe("runtime protocol compatibility corpus", () => {
  it.each(corpus)("accepts $name through $schema", ({ schema, payload }) => {
    const result = schemas[schema as keyof typeof schemas].safeParse(payload);
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues, null, 2)).toBe(true);
  });
});
