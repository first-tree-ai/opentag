import { StructuredErrorSchema } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { OpenTagApiError } from "../api.js";
import { RuntimeDurabilityFailure } from "../runtime/runtime-durability.js";

describe("client error taxonomy adoption", () => {
  it("exposes a schema-valid diagnostic for API failures", () => {
    const error = new OpenTagApiError(
      "SERVICE_UNAVAILABLE",
      "transient",
      "The service is unavailable",
      503,
      undefined,
      {
        requestId: "request-1",
      },
    );
    expect(StructuredErrorSchema.parse(error.structuredError)).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      category: "unavailable",
      retryability: "backoff",
      phase: "request",
      requestId: "request-1",
    });
  });

  it("keeps durable failures schema-valid", () => {
    const failure = new RuntimeDurabilityFailure({
      code: "transport_unavailable",
      category: "unavailable",
      retryability: "backoff",
      phase: "transport",
      requestId: "request-1",
      message: "The runtime transport is unavailable",
    });
    expect(StructuredErrorSchema.parse(failure.structuredError)).toMatchObject({
      code: "transport_unavailable",
      category: "unavailable",
      retryability: "backoff",
      phase: "transport",
      requestId: "request-1",
    });
  });
});
