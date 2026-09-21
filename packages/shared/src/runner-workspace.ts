import { z } from "zod";

/** Latest-state persistence, negotiated independently of delivery and credential transport. */
export const RUNNER_WORKSPACE_VERSION = 1 as const;
export const RUNNER_WORKSPACE_PATH = "/api/v1/sandbox-runner/workspace" as const;
export const RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const RUNNER_WORKSPACE_TIMEOUT_MS = 120_000;

/** GCS generations are opaque decimal strings; conversion to Number loses precision. */
export const RunnerWorkspaceObjectSchema = z
  .object({
    generation: z.string().regex(/^[1-9][0-9]{0,29}$/),
    metageneration: z.string().regex(/^[1-9][0-9]{0,29}$/),
    ownerGeneration: z.number().int().positive().safe(),
    saved: z.boolean(),
    sealed: z.boolean(),
    bytes: z.number().int().nonnegative().max(RUNNER_WORKSPACE_ARCHIVE_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    md5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  })
  .strict();
export type RunnerWorkspaceObject = z.infer<typeof RunnerWorkspaceObjectSchema>;

/** Stop all workspace writers, save the latest complete state, and remain sealed until release. */
export const RunnerWorkspaceSealFrameSchema = z
  .object({
    type: z.literal("workspace:seal"),
    requestId: z.string().uuid(),
  })
  .strict();
export type RunnerWorkspaceSealFrame = z.infer<typeof RunnerWorkspaceSealFrameSchema>;

export const RunnerWorkspaceSealResultFrameSchema = z
  .object({
    type: z.literal("workspace:seal:result"),
    requestId: z.string().uuid(),
    ok: z.boolean(),
    code: z.enum(["workspace_save_failed", "workspace_not_restored"]).optional(),
  })
  .strict();
export type RunnerWorkspaceSealResultFrame = z.infer<typeof RunnerWorkspaceSealResultFrameSchema>;
