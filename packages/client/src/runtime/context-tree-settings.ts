import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type ContextTreeOperationFrame,
  type ContextTreeOperationResponse,
  ContextTreeOperationResponseSchema,
} from "@opentag/shared";
import { z } from "zod";
import { ensurePrivateDirectory, readDurableJson, writeDurableFile } from "../storage/durable-file.js";
import { resolveContextTreePackage, runContextTreeCli } from "./context-tree.js";

const RecordSchema = z.object({ fingerprint: z.string(), result: ContextTreeOperationResponseSchema }).strict();
type Run = (args: readonly string[]) => Promise<{ payload: unknown; failureCode?: string }>;

/** Persist publication intent before invoking gh. Lost responses never imply permission to publish again. */
export class ContextTreeSettings {
  constructor(
    readonly options: {
      home: string;
      environment: NodeJS.ProcessEnv;
      hasAgentSessions: (agentId: string) => boolean;
      exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
      run?: Run;
    },
  ) {}

  run(frame: ContextTreeOperationFrame): Promise<ContextTreeOperationResponse> {
    return this.options.exclusive(() => this.#run(frame));
  }

  async #run(frame: ContextTreeOperationFrame): Promise<ContextTreeOperationResponse> {
    if (frame.requireStopped && this.options.hasAgentSessions(frame.agentId)) return failed("busy");
    const assets = resolveContextTreePackage();
    if (!assets && !this.options.run) return failed("capability_missing");
    const run: Run =
      this.options.run ??
      ((args) => {
        if (!assets) throw new Error("Context Tree package missing");
        return runContextTreeCli(assets, args, { env: this.options.environment, network: true });
      });
    const input = frame.input;
    const directory = join(this.options.home, "state", "context-tree-operations");
    await ensurePrivateDirectory(this.options.home, directory);
    const fingerprint = JSON.stringify([frame.agentId, input.action, input.repository]);
    const recordFile = join(directory, `${input.operationId}.json`);
    const previous = await readDurableJson(recordFile, RecordSchema.parse);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : failed("stale_configuration");
    const save = async (result: ContextTreeOperationResponse) => {
      await writeDurableFile(recordFile, JSON.stringify({ fingerprint, result }));
      return result;
    };
    // Actual workspace disconnection is serialized at next startup with its saved null snapshot.
    // Settings validation never mutates the connection a concurrently resumed runtime may use.
    if (input.action === "disconnect") return save({ status: "completed", repository: null });
    const setup = join(directory, `setup-${input.operationId}`);
    await ensurePrivateDirectory(this.options.home, setup);
    const project = ["--project-path", setup, "--json"];
    if (input.action === "create") {
      const publicationFile = join(
        directory,
        `publication-${createHash("sha256")
          .update(input.repository ?? "")
          .digest("hex")}.json`,
      );
      const publication = await readDurableJson(publicationFile, ContextTreeOperationResponseSchema.parse);
      if (publication?.status === "failed" && publication.code === "publication_uncertain") return save(publication);
      if (publication?.status !== "completed") {
        const created = await run(["create", ...project]);
        if (created.failureCode) return save(classify(created.failureCode));
        await writeDurableFile(publicationFile, JSON.stringify(failed("publication_uncertain")));
        const published = await run(["publish", input.repository ?? "", ...project]);
        const outcome: ContextTreeOperationResponse = published.failureCode
          ? classify(published.failureCode, true)
          : { status: "completed", repository: input.repository };
        await writeDurableFile(publicationFile, JSON.stringify(outcome));
        if (outcome.status === "failed") return save(outcome);
      }
    }
    const connected = await run(["connect", input.repository ?? "", ...project]);
    let result: ContextTreeOperationResponse = connected.failureCode
      ? classify(connected.failureCode)
      : { status: "completed", repository: input.repository };
    if (result.status === "completed") {
      const payload = z.object({ tree: z.object({ path: z.string().min(1) }) }).safeParse(connected.payload);
      if (!payload.success) result = failed("invalid_tree");
      else {
        const verified = await run(["verify", "--tree-path", payload.data.tree.path, "--json"]);
        if (verified.failureCode) result = failed("invalid_tree");
      }
    }
    const disconnected = await run(["disconnect", ...project]);
    if (disconnected.failureCode && result.status === "completed") result = failed("failed");
    return save(result);
  }
}

function failed(
  code: Extract<ContextTreeOperationResponse, { status: "failed" }>["code"],
): ContextTreeOperationResponse {
  return { status: "failed", code };
}
function classify(code: string, publishing = false): ContextTreeOperationResponse {
  if (code === "GITHUB_AUTH") return failed("authentication_required");
  if (code === "GITHUB_PERMISSION") return failed("permission_denied");
  if (code === "REPOSITORY_EXISTS") return failed("repository_exists");
  if (code === "PUBLISH_INCOMPLETE" || publishing) return failed("publication_uncertain");
  if (["INVALID_TREE", "DIRTY_TREE", "NO_CONNECTION"].includes(code)) return failed("invalid_tree");
  return failed("failed");
}
