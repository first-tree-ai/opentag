/**
 * The one seam the Agent Setup surface sits on. The surface renders the F0 `AgentSetupSnapshot`
 * exactly as it arrives and dispatches only the actions the snapshot lists; everything it needs
 * from outside itself — one read and a handful of writes — is behind this interface, so the HTTP
 * implementation and the in-memory one can be held to the same behavior in tests.
 *
 * The shape is written in the surface's vocabulary rather than the transport's: starting a Feishu
 * attempt returns nothing because the attempt's QR and expiry are read back from the next
 * snapshot, which is the only state the surface renders. Only Slack's install escapes that rule —
 * its answer is a URL the browser is sent to, which no later snapshot can deliver.
 */

import type {
  AgentSetupSnapshot,
  FeishuSetupAttempt,
  FeishuSetupIntent,
  ImBindingMessagingExpectation,
  ImProvider,
  SlackConfigurationIntent,
  StartSlackOAuthRequest,
  StartSlackOAuthResponse,
  UnbindAgentMessagingRequest,
} from "@opentag/shared/browser";
import type { QueryClient } from "@tanstack/react-query";
import { browserApi } from "../api.js";
import { syncAgentQueries } from "../query/agent-sync.js";
import { queryKeys } from "../query/keys.js";
import { fetchSharedResource } from "../query/session-cache.js";

export interface AgentSetupAdapter {
  /** The canonical setup state of one exact Agent — the only read this surface makes. */
  readonly readSnapshot: (agentId: string) => Promise<AgentSetupSnapshot>;
  /** Starts a real preparation on an already-connected Computer; never aliases a snapshot read. */
  readonly refreshPreparation: (agentId: string) => Promise<void>;
  /**
   * Opens one Feishu authorization attempt on the exact Agent: `create` for a first connection,
   * `reauthorize` to renew the current binding's permissions, `replace` to swap its bot. There is
   * deliberately no cross-Provider variant; changing Providers is unbind, then a fresh start.
   */
  readonly startFeishuAttempt: (
    agentId: string,
    intent: FeishuSetupIntent,
    expectedMessaging: ImBindingMessagingExpectation,
  ) => Promise<void>;
  /** Cancels the exact open Feishu attempt. Attempts are keyed globally, so no Agent id is taken. */
  readonly cancelFeishuAttempt: (attemptId: string) => Promise<void>;
  /** Starts Slack's install or reauthorization; resolves the URL the browser must be sent to. */
  readonly startSlackInstall: (
    agentId: string,
    intent: SlackConfigurationIntent,
    expectedMessaging: ImBindingMessagingExpectation,
  ) => Promise<string>;
  /** Disables the exact current binding. A fresh Provider can be started only after this lands. */
  readonly unbindMessaging: (agentId: string, provider: ImProvider, bindingId: string) => Promise<void>;
}

interface AgentSetupBrowserApi {
  readonly agentSetup: (agentId: string) => Promise<AgentSetupSnapshot>;
  readonly refreshAgentSetup: (agentId: string) => Promise<void>;
  readonly createFeishuSetupAttempt: (
    agentId: string,
    intent: FeishuSetupIntent,
    expectedMessaging?: ImBindingMessagingExpectation,
  ) => Promise<FeishuSetupAttempt>;
  readonly cancelFeishuSetupAttempt: (attemptId: string) => Promise<FeishuSetupAttempt>;
  readonly startSlackOAuth: (agentId: string, input: StartSlackOAuthRequest) => Promise<StartSlackOAuthResponse>;
  readonly unbindAgentMessaging: (agentId: string, input: UnbindAgentMessagingRequest) => Promise<void>;
}

/** The production adapter: every call is the matching BrowserApi request, nothing more. */
export function createHttpSetupAdapter(
  api: AgentSetupBrowserApi = browserApi,
  queryClient?: QueryClient,
): AgentSetupAdapter {
  /*
   * A write moves the resource an earlier snapshot described, so a snapshot GET begun before the
   * write must not answer the read that follows it: the shared cache would otherwise hand the
   * post-write read the pre-write request's promise. Retiring in-flight snapshot reads at the
   * operation boundary makes the controller's next read a request that starts after the write,
   * whether the write succeeded or the reader still needs the state the failure left behind.
   * Reads begun within the same operation still share one in-flight GET, and nothing here
   * invalidates — the page decides when the next read happens.
   */
  const retireSnapshotReads = async (agentId?: string): Promise<void> => {
    if (!queryClient) return;
    await queryClient.cancelQueries({
      queryKey: agentId === undefined ? queryKeys.agentSetupRoot() : queryKeys.agentSetup(agentId),
    });
  };
  return {
    readSnapshot: (agentId) =>
      queryClient
        ? fetchSharedResource(queryClient, {
            queryKey: queryKeys.agentSetup(agentId),
            queryFn: () => api.agentSetup(agentId),
            staleTime: 0,
          })
        : api.agentSetup(agentId),
    refreshPreparation: async (agentId) => {
      try {
        await api.refreshAgentSetup(agentId);
      } finally {
        await retireSnapshotReads(agentId);
      }
    },
    startFeishuAttempt: async (agentId, intent, expectedMessaging) => {
      try {
        await api.createFeishuSetupAttempt(agentId, intent, expectedMessaging);
      } finally {
        await retireSnapshotReads(agentId);
      }
    },
    cancelFeishuAttempt: async (attemptId) => {
      try {
        await api.cancelFeishuSetupAttempt(attemptId);
      } finally {
        // Attempts are keyed globally, so this seam never names an Agent; retire any setup read.
        await retireSnapshotReads();
      }
    },
    startSlackInstall: async (agentId, intent, expectedMessaging) => {
      try {
        const started = await api.startSlackOAuth(agentId, {
          intent,
          returnSurface: "agent-setup",
          expectedMessaging,
        });
        return started.authorizationUrl;
      } finally {
        await retireSnapshotReads(agentId);
      }
    },
    unbindMessaging: async (agentId, provider, bindingId) => {
      try {
        await api.unbindAgentMessaging(agentId, { provider, bindingId });
      } finally {
        await retireSnapshotReads(agentId);
      }
      if (queryClient) void syncAgentQueries(queryClient, agentId);
    },
  };
}
