import { describe, expect, it, vi } from "vitest";
import { ImDeliveryWorker } from "../runtime/im-delivery-worker.js";

describe("ImDeliveryWorker diagnostics", () => {
  it("contains a scheduler database failure and emits only a bounded diagnostic code", async () => {
    const diagnostic = vi.fn();
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error("secret provider response must not escape")),
    };
    const worker = new ImDeliveryWorker({
      assembler: { assembleForSession: vi.fn() },
      database: database as never,
      domain: {} as never,
      registry: {} as never,
      intervalMs: 60_000,
      onDiagnostic: diagnostic,
    });

    worker.start();
    await expect.poll(() => diagnostic.mock.calls.length).toBe(1);
    worker.stop();
    expect(diagnostic).toHaveBeenCalledWith("IM_DELIVERY_WORKER_SCHEDULING_FAILED");
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret provider response");
  });
});
