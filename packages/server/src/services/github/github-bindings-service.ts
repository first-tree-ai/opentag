import {
  GITHUB_REPOSITORY_BINDINGS_SCHEMA_VERSION,
  type GitHubConnectionStatus,
  type GitHubRepositoryBinding,
  GitHubRepositoryBindingsSchema,
} from "@opentag/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, githubConnections } from "../../db/schema/index.js";
import {
  GITHUB_ADMISSION_PROOF_MAX_AGE_MS,
  type GitHubRepositoryAdmissionProof,
  hashGitHubRepositoryBindings,
  verifyGitHubRepositoryAdmissionProof,
} from "./bindings-proof.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import { requireOwnedConnection, toGitHubConnectionStatus } from "./rows.js";

export interface GitHubBindingsServiceOptions {
  now?: () => Date;
  admissionProofMaxAgeMs?: number;
}

/**
 * The single write entry for the repository/Agent binding configuration. The write transaction locks
 * Agents in sorted ID order and then the connection, re-verifies Account ownership of the connection
 * and every referenced Agent, applies the expectedAuthorizationVersion CAS, and requires a typed
 * admission proof bound to the exact requested bindings. A successful update bumps only the
 * authorization version; it never rewrites credentials.
 */
export class GitHubBindingsService {
  private readonly now: () => Date;
  private readonly admissionProofMaxAgeMs: number;

  constructor(
    private readonly database: DatabaseClient,
    options: GitHubBindingsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.admissionProofMaxAgeMs = options.admissionProofMaxAgeMs ?? GITHUB_ADMISSION_PROOF_MAX_AGE_MS;
  }

  async updateBindings(
    accountId: string,
    connectionId: string,
    input: {
      expectedAuthorizationVersion: bigint;
      bindings: GitHubRepositoryBinding[];
      admissionProof: GitHubRepositoryAdmissionProof;
    },
  ): Promise<GitHubConnectionStatus> {
    const bindings = GitHubRepositoryBindingsSchema.parse(input.bindings);
    const bindingsHash = hashGitHubRepositoryBindings(bindings);
    return this.database.transaction(async (transaction) => {
      // Verify Account ownership before any Agent work so a foreign caller learns nothing; the
      // locked re-read below re-verifies it against concurrent disconnect/replace races.
      const [visible] = await transaction
        .select({ id: githubConnections.id, accountId: githubConnections.accountId })
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .limit(1);
      requireOwnedConnection(visible, accountId);
      const agentIds = [
        ...new Set(bindings.flatMap((binding) => binding.agentScopes.map((scope) => scope.agentId))),
      ].sort();
      for (const agentId of agentIds) {
        const [agent] = await transaction.select().from(agents).where(eq(agents.id, agentId)).for("update");
        if (!agent || agent.createdByUserId !== accountId || agent.status === "deleted") {
          throw new GitHubConnectionServiceError(
            GITHUB_CONNECTION_ERROR_CODES.AGENT_OWNERSHIP_INVALID,
            403,
            "Every binding Agent must exist and belong to the connection's Account",
          );
        }
      }
      const [row] = await transaction
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .for("update");
      const ownedRow = requireOwnedConnection(row, accountId);
      assertStableBindingIds(ownedRow.repositoryBindings, bindings);
      if (ownedRow.status !== "active") {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
          409,
          "Bindings change only on an active connection",
        );
      }
      if (ownedRow.authorizationVersion !== input.expectedAuthorizationVersion) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT,
          409,
          "The connection's authorization version no longer matches; re-read and retry",
        );
      }
      if (agentIds.length > 0) {
        const otherConnections = await transaction
          .select({ bindings: githubConnections.repositoryBindings })
          .from(githubConnections)
          .where(
            and(
              eq(githubConnections.accountId, accountId),
              ne(githubConnections.id, connectionId),
              inArray(githubConnections.status, ["active", "reauthorization_required"]),
              sql`exists (
              select 1 from jsonb_array_elements(${githubConnections.repositoryBindings}) binding,
                jsonb_array_elements(binding -> 'agentScopes') scope
              where scope ->> 'agentId' in (${sql.join(
                agentIds.map((id) => sql`${id}`),
                sql`, `,
              )})
            )`,
            ),
          );
        assertUniqueCurrentScopes(
          bindings,
          otherConnections.flatMap((row) => row.bindings),
        );
      }
      const now = this.now();
      verifyGitHubRepositoryAdmissionProof(
        input.admissionProof,
        {
          connectionId: ownedRow.id,
          authorizationVersion: ownedRow.authorizationVersion,
          githubUserId: ownedRow.githubUserId,
        },
        bindingsHash,
        now,
        this.admissionProofMaxAgeMs,
      );
      const [updated] = await transaction
        .update(githubConnections)
        .set({
          repositoryBindings: bindings,
          bindingsSchemaVersion: GITHUB_REPOSITORY_BINDINGS_SCHEMA_VERSION,
          authorizationVersion: ownedRow.authorizationVersion + 1n,
          updatedAt: now,
        })
        .where(
          and(
            eq(githubConnections.id, ownedRow.id),
            eq(githubConnections.authorizationVersion, input.expectedAuthorizationVersion),
          ),
        )
        .returning();
      if (!updated) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT,
          409,
          "The connection's authorization version changed during the update",
        );
      }
      return toGitHubConnectionStatus(updated);
    });
  }
}

/** Agent row locks serialize grants across connections; reauthorization retains its reserved scopes. */
function assertUniqueCurrentScopes(next: GitHubRepositoryBinding[], other: GitHubRepositoryBinding[]): void {
  const treeAgents = new Set<string>();
  const roles = new Set<string>();
  for (const binding of other) {
    for (const scope of binding.agentScopes) {
      roles.add(`${scope.agentId}:${binding.repositoryId}:${scope.role}`);
      if (scope.role === "context_tree") treeAgents.add(scope.agentId);
    }
  }
  for (const binding of next) {
    for (const scope of binding.agentScopes) {
      if (
        roles.has(`${scope.agentId}:${binding.repositoryId}:${scope.role}`) ||
        (scope.role === "context_tree" && treeAgents.has(scope.agentId))
      ) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
          409,
          "An Agent's repository role or Context Tree is already assigned through another current connection",
        );
      }
    }
  }
}

function assertStableBindingIds(previous: GitHubRepositoryBinding[], next: GitHubRepositoryBinding[]): void {
  const byId = new Map(previous.map((binding) => [binding.bindingId, binding]));
  for (const binding of next) {
    const old = byId.get(binding.bindingId);
    if (old && (old.installationId !== binding.installationId || old.repositoryId !== binding.repositoryId)) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
        409,
        "A binding ID cannot be reassigned to another repository or installation",
      );
    }
  }
}
