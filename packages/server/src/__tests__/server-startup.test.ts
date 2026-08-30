import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  config: {} as Record<string, unknown>,
  app: undefined as unknown,
  appOptions: undefined as unknown,
  onClose: undefined as (() => Promise<void>) | undefined,
  database: undefined as unknown,
  selectedAgents: [] as Array<{ computerId: string; runtimeProvider: "codex" | "claude-code" }>,
  sql: { end: vi.fn() },
  parseServerConfig: vi.fn(),
  migrateDatabase: vi.fn(),
  verifyDatabaseMigrations: vi.fn(),
  createDatabaseClient: vi.fn(),
  createApp: vi.fn(),
  registryCurrentInstanceId: vi.fn(),
  registrySupportsProvider: vi.fn(),
  registryProviderReadiness: vi.fn(),
  registryImCliReadiness: vi.fn(),
  imBindingOptions: undefined as unknown,
  imBindingGetAgentComputerId: vi.fn(),
  feishuConnectionOptions: undefined as unknown,
  feishuConnectionStart: vi.fn(),
  feishuConnectionStop: vi.fn(),
  feishuSetupOptions: undefined as unknown,
  feishuSetupStart: vi.fn(),
  feishuSetupStop: vi.fn(),
  workerOptions: undefined as unknown,
  workerStart: vi.fn(),
  workerStop: vi.fn(),
  domainOptions: undefined as unknown,
  issueRuntimeCredentialGrant: vi.fn(),
  devAuthArgs: undefined as unknown,
  slackAdapterOptions: undefined as unknown,
}));

vi.mock("../app.js", () => ({ createApp: state.createApp }));
vi.mock("../admin/bootstrap.js", () => ({ bootstrapInitialAdmin: vi.fn() }));
vi.mock("../bootstrap-readiness.js", () => ({
  BootstrapReadiness: class {
    complete(stage: string) {
      state.events.push(`ready:${stage}`);
    }
  },
}));
vi.mock("../config.js", () => ({
  parseServerConfig: state.parseServerConfig,
  isHostedEnvironment: vi.fn(() => true),
  serverEnvironmentSummary: vi.fn(() => ({ environment: "prod" })),
}));
vi.mock("../db/client.js", () => ({ createDatabaseClient: state.createDatabaseClient }));
vi.mock("../db/migrate.js", () => ({
  MigrationVerificationError: class extends Error {},
  migrateDatabase: state.migrateDatabase,
  verifyDatabaseMigrations: state.verifyDatabaseMigrations,
  withMigrationLock: vi.fn(),
}));
vi.mock("../runtime/connection-registry.js", () => ({
  ConnectionRegistry: class {
    currentInstanceId(computerId: string) {
      return state.registryCurrentInstanceId(computerId);
    }
    supportsProvider(computerId: string, instanceId: string, provider: string) {
      return state.registrySupportsProvider(computerId, instanceId, provider);
    }
    providerReadiness(computerId: string) {
      return state.registryProviderReadiness(computerId);
    }
    imCliReadiness(computerId: string) {
      return state.registryImCliReadiness(computerId);
    }
    closeEnrollment() {}
  },
  RuntimeRegistrySendError: class extends Error {},
}));
vi.mock("../runtime/im-delivery-worker.js", () => ({
  ImDeliveryWorker: class {
    constructor(options: unknown) {
      state.workerOptions = options;
    }
    start() {
      state.events.push("worker:start");
      state.workerStart();
    }
    stop() {
      state.events.push("worker:stop");
      state.workerStop();
    }
  },
}));
vi.mock("../runtime/runtime-custody-store.js", () => ({ PostgresRuntimeCustodyStore: class {} }));
vi.mock("../runtime/runtime-domain-owner.js", () => ({
  RuntimeDomainConflictError: class extends Error {},
  RuntimeDomainOwner: class {
    constructor(_registry: unknown, _store: unknown, options: unknown) {
      state.domainOptions = options;
    }
  },
  RuntimeDomainRequestError: class extends Error {},
}));
vi.mock("../services/agents/index.js", () => ({ AgentService: class {}, AgentServiceError: class extends Error {} }));
vi.mock("../services/auth/index.js", () => ({
  AuthService: class {},
  AuthServiceError: class extends Error {},
  ConnectCodeService: class {},
  DevBrowserAuthService: class {
    constructor(...args: unknown[]) {
      state.devAuthArgs = args;
    }
  },
  formatStartupError: (error: unknown, knownSecrets: string[]) => {
    let detail = error instanceof Error ? error.message : String(error);
    for (const secret of knownSecrets) if (secret) detail = detail.replaceAll(secret, "[REDACTED]");
    return detail;
  },
  PostAuthenticationService: class {},
}));
vi.mock("../services/computers/index.js", () => ({
  ComputerService: class {},
  MachineAuthService: class {},
}));
vi.mock("../services/crypto.js", () => ({ ApplicationCipher: class {} }));
vi.mock("../services/im/index.js", () => ({
  ImMessageInbox: class {},
  ImResourceService: class {},
}));
vi.mock("../services/im-bindings/feishu/index.js", () => ({
  DefaultFeishuRegistrationGateway: class {},
  FeishuConnectionManager: class {
    constructor(options: unknown) {
      state.feishuConnectionOptions = options;
    }
    start() {
      state.events.push("feishu-connections:start");
      state.feishuConnectionStart();
    }
    async stop() {
      state.events.push("feishu-connections:stop");
      await state.feishuConnectionStop();
    }
  },
  FeishuSetupService: class {
    constructor(options: unknown) {
      state.feishuSetupOptions = options;
    }
    start() {
      state.events.push("feishu-setup:start");
      state.feishuSetupStart();
    }
    async stop() {
      state.events.push("feishu-setup:stop");
      await state.feishuSetupStop();
    }
  },
}));
vi.mock("../services/im-bindings/index.js", () => ({
  createImProviderAdapterResolver: vi.fn(() => vi.fn()),
  ImBindingService: class {
    constructor(_database: unknown, _cipher: unknown, options: unknown) {
      state.imBindingOptions = options;
    }
    getAgentComputerId(agentId: string) {
      return state.imBindingGetAgentComputerId(agentId);
    }
    issueRuntimeCredentialGrant(request: unknown, computerId: string) {
      return state.issueRuntimeCredentialGrant(request, computerId);
    }
  },
}));
vi.mock("../services/im-bindings/slack/index.js", () => ({
  DefaultSlackApiClient: class {},
  SlackConfigurationService: class {},
  SlackOAuthService: class {},
  SlackOAuthStateService: class {},
  SlackAdapter: class {
    constructor(options: unknown) {
      state.slackAdapterOptions = options;
    }
  },
}));
vi.mock("../services/runtime-config/index.js", () => ({ EffectiveRuntimeSnapshotAssembler: class {} }));
vi.mock("../services/setup/index.js", () => ({
  AccountSetupService: class {},
}));
vi.mock("../web-app.js", () => ({ defaultWebAppRoot: "/mock-web" }));

import { startServer } from "../index.js";

const originalSecrets = {
  database: process.env.OPENTAG_DATABASE_URL,
  jwt: process.env.OPENTAG_JWT_SECRET,
  google: process.env.OPENTAG_GOOGLE_CLIENT_SECRET,
  encryption: process.env.OPENTAG_ENCRYPTION_KEY,
  slackClient: process.env.OPENTAG_SLACK_CLIENT_SECRET,
  slackSigning: process.env.OPENTAG_SLACK_SIGNING_SECRET,
};
const originalExitCode = process.exitCode;

function defaultConfig() {
  return {
    autoMigrate: true,
    databaseUrl: "postgres://db-user:db-password@localhost/opentag",
    encryptionKey: new Uint8Array(32),
    channel: {
      binName: "opentag",
      channel: "prod",
      defaultHome: "/tmp/opentag",
      displayName: "OpenTag",
      packageName: "@opentag/cli",
      serviceId: "opentag",
    },
    environment: "prod",
    devAuth: { email: "dev@example.com" },
    google: { clientId: "google-client", clientSecret: "google-secret" },
    host: "127.0.0.1",
    jwtSecret: "jwt-secret",
    migrationsDirectory: "/mock/migrations",
    observability: {
      tracing: {
        endpoint: "",
        environment: "test",
        headers: "",
        sampleRate: 1,
      },
    },
    port: 8000,
    publicUrl: "https://opentag.example.com",
    sessionTtlSeconds: 2_592_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.events.length = 0;
  state.config = defaultConfig();
  state.appOptions = undefined;
  state.onClose = undefined;
  state.selectedAgents = [{ computerId: "computer-1", runtimeProvider: "codex" }];
  state.imBindingOptions = undefined;
  state.feishuConnectionOptions = undefined;
  state.feishuSetupOptions = undefined;
  state.workerOptions = undefined;
  state.domainOptions = undefined;
  state.devAuthArgs = undefined;
  state.slackAdapterOptions = undefined;
  state.sql = { end: vi.fn(async () => state.events.push("sql:end")) };
  state.database = {
    select: vi.fn(() => {
      const query = {
        innerJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => state.selectedAgents),
      };
      return { from: vi.fn(() => query) };
    }),
  };
  state.parseServerConfig.mockImplementation(() => state.config);
  state.migrateDatabase.mockImplementation(async () => state.events.push("migration:run"));
  state.verifyDatabaseMigrations.mockImplementation(async () => state.events.push("migration:verify"));
  state.createDatabaseClient.mockImplementation(() => ({ database: state.database, sql: state.sql }));
  state.registryCurrentInstanceId.mockReturnValue("instance-1");
  state.registrySupportsProvider.mockReturnValue(true);
  state.registryProviderReadiness.mockReturnValue([
    { observation: { provider: "codex", status: "ready" }, observedAt: Date.now() },
  ]);
  state.registryImCliReadiness.mockReturnValue([]);
  state.imBindingGetAgentComputerId.mockResolvedValue("computer-1");
  state.issueRuntimeCredentialGrant.mockResolvedValue({
    type: "im:credential:result",
    requestId: "request-1",
    status: "rejected",
    code: "binding_inactive",
  });
  const log = { info: vi.fn(), error: vi.fn() };
  state.app = {
    addHook: vi.fn((_name: string, hook: () => Promise<void>) => {
      state.onClose = hook;
    }),
    listen: vi.fn(async () => state.events.push("listen")),
    close: vi.fn(async () => {
      state.events.push("app:close");
      await state.onClose?.();
    }),
    log,
  };
  state.createApp.mockImplementation((options: unknown) => {
    state.appOptions = options;
    return state.app;
  });
  process.env.OPENTAG_DATABASE_URL = "postgres://db-user:db-password@localhost/opentag";
  process.env.OPENTAG_JWT_SECRET = "jwt-secret";
  process.env.OPENTAG_GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.OPENTAG_ENCRYPTION_KEY = "encryption-secret";
  process.env.OPENTAG_SLACK_CLIENT_SECRET = "slack-client-secret";
  process.env.OPENTAG_SLACK_SIGNING_SECRET = "slack-signing-secret";
  process.exitCode = undefined;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("OPENTAG_DATABASE_URL", originalSecrets.database);
  restore("OPENTAG_JWT_SECRET", originalSecrets.jwt);
  restore("OPENTAG_GOOGLE_CLIENT_SECRET", originalSecrets.google);
  restore("OPENTAG_ENCRYPTION_KEY", originalSecrets.encryption);
  restore("OPENTAG_SLACK_CLIENT_SECRET", originalSecrets.slackClient);
  restore("OPENTAG_SLACK_SIGNING_SECRET", originalSecrets.slackSigning);
  process.exitCode = originalExitCode;
});

describe("Server startup", () => {
  it("migrates before listen, wires runtime/auth/provider services, and cleans up in reverse ownership order", async () => {
    await startServer();

    expect(state.migrateDatabase).toHaveBeenCalledWith(state.config.databaseUrl, state.config.migrationsDirectory);
    expect(state.verifyDatabaseMigrations).not.toHaveBeenCalled();
    expect(state.events).toEqual([
      "ready:configuration",
      "migration:run",
      "ready:migration",
      "feishu-setup:start",
      "feishu-connections:start",
      "worker:start",
      "ready:application",
      "listen",
      "ready:listen",
    ]);

    const appOptions = state.appOptions as {
      browserAuth: { devSignIn: unknown; googleSignIn: unknown; secureCookies: boolean };
      slackEvents: { createAdapter(binding: unknown): unknown };
    };
    expect(appOptions.browserAuth).toMatchObject({ secureCookies: true });
    expect(appOptions.browserAuth.devSignIn).toBe(true);
    // Google sign-in is a flag now: the whole flow lives in Better Auth, so there is no service to hand a route.
    expect(appOptions.browserAuth.googleSignIn).toBe(true);
    expect(state.devAuthArgs).toEqual(expect.arrayContaining(["dev@example.com"]));

    const slackBinding = {
      botAccessToken: "xoxb-current",
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
    };
    appOptions.slackEvents.createAdapter(slackBinding);
    expect(state.slackAdapterOptions).toMatchObject({
      appId: "A1",
      teamId: "T1",
      botUserId: "U1",
      botId: "B1",
      token: "xoxb-current",
    });

    const imCliReadiness = (
      state.imBindingOptions as {
        imCliReadiness(agentId: string, provider: "feishu" | "slack"): Promise<string>;
      }
    ).imCliReadiness;
    state.registryImCliReadiness.mockReturnValue([
      { observation: { provider: "feishu", status: "ready" }, observedAt: Date.now() },
    ]);
    await expect(imCliReadiness("agent-1", "feishu")).resolves.toBe("ready");
    state.registryImCliReadiness.mockReturnValue([]);
    await expect(imCliReadiness("agent-1", "slack")).resolves.toBe("checking");
    state.imBindingGetAgentComputerId.mockResolvedValueOnce(undefined);
    await expect(imCliReadiness("agent-1", "slack")).resolves.toBe("unavailable");

    const agentRuntimeReadiness = (
      state.imBindingOptions as { agentRuntimeReadiness(agentId: string): Promise<string> }
    ).agentRuntimeReadiness;
    await expect(agentRuntimeReadiness("agent-1")).resolves.toBe("ready");
    state.registryProviderReadiness.mockReturnValueOnce([
      { observation: { provider: "codex", status: "sign-in" }, observedAt: Date.now() },
    ]);
    await expect(agentRuntimeReadiness("agent-1")).resolves.toBe("sign-in");

    const feishuRuntimeReady = (state.feishuConnectionOptions as { runtimeReady(agentId: string): Promise<boolean> })
      .runtimeReady;
    state.registryCurrentInstanceId.mockReturnValue("instance-1");
    await expect(feishuRuntimeReady("agent-1")).resolves.toBe(true);
    state.selectedAgents = [];
    await expect(feishuRuntimeReady("agent-1")).resolves.toBe(false);

    const onImCredentialGrant = (
      state.domainOptions as {
        onImCredentialGrant(request: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>;
      }
    ).onImCredentialGrant;
    state.issueRuntimeCredentialGrant.mockResolvedValue({
      type: "im:credential:result",
      requestId: "request-1",
      status: "rejected",
      code: "binding_inactive",
    });
    await expect(
      onImCredentialGrant(
        {
          type: "im:credential",
          requestId: "request-1",
          sessionId: "session-1",
          agentId: "agent-1",
          placementGeneration: 3,
        },
        {
          computerId: "workspace-computer-1",
          installationId: "computer-1",
          instanceId: "instance-1",
        },
      ),
    ).resolves.toMatchObject({ type: "im:credential:result", requestId: "request-1", status: "rejected" });
    expect(state.issueRuntimeCredentialGrant).toHaveBeenCalledWith(
      expect.objectContaining({ type: "im:credential", requestId: "request-1" }),
      expect.objectContaining({
        computerId: "workspace-computer-1",
        installationId: "computer-1",
      }),
    );

    (state.workerOptions as { onDiagnostic(code: string): void }).onDiagnostic("IM_DELIVERY_FAILED");
    expect((state.app as { log: { error: ReturnType<typeof vi.fn> } }).log.error).toHaveBeenCalledWith(
      { code: "IM_DELIVERY_FAILED" },
      "Server diagnostic",
    );

    const app = state.app as { addHook: ReturnType<typeof vi.fn>; close(): Promise<void> };
    expect(app.addHook).toHaveBeenCalledWith("onClose", expect.any(Function));
    await app.close();
    expect(state.events.slice(-5)).toEqual([
      "app:close",
      "worker:stop",
      "feishu-setup:stop",
      "feishu-connections:stop",
      "sql:end",
    ]);
  });

  it("verifies checked-in migrations before listening when auto-migrate is disabled", async () => {
    state.config = { ...defaultConfig(), autoMigrate: false, google: undefined, devAuth: undefined };

    await startServer();

    expect(state.migrateDatabase).not.toHaveBeenCalled();
    expect(state.verifyDatabaseMigrations).toHaveBeenCalledWith(
      state.config.databaseUrl,
      state.config.migrationsDirectory,
    );
    expect(state.events.indexOf("migration:verify")).toBeLessThan(state.events.indexOf("listen"));
    const browserAuth = (state.appOptions as { browserAuth: { googleSignIn?: unknown; devSignIn?: unknown } })
      .browserAuth;
    expect(browserAuth.googleSignIn).toBe(false);
    expect(browserAuth.devSignIn).toBe(false);
  });

  it.each([
    ["configuration", []],
    ["migration", ["ready:configuration"]],
  ])(
    "fails during %s without announcing later readiness or exposing known secrets",
    async (failureStage, expectedEvents) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const failure = new Error(
        "postgres://db-user:db-password@localhost/opentag jwt-secret google-secret encryption-secret slack-client-secret slack-signing-secret",
      );
      if (failureStage === "configuration")
        state.parseServerConfig.mockImplementation(() => {
          throw failure;
        });
      else state.migrateDatabase.mockRejectedValue(failure);

      await startServer();

      expect(state.createApp).not.toHaveBeenCalled();
      expect(state.events).toEqual(expectedEvents);
      expect(process.exitCode).toBe(1);
      const output = stderr.mock.calls.flat().join(" ");
      expect(output).toContain("Failed to start OpenTag server");
      for (const secret of [
        "postgres://db-user:db-password@localhost/opentag",
        "jwt-secret",
        "google-secret",
        "encryption-secret",
        "slack-client-secret",
        "slack-signing-secret",
      ]) {
        expect(output).not.toContain(secret);
      }
      stderr.mockRestore();
    },
  );

  it("logs a redacted post-creation failure and closes every started resource", async () => {
    const app = state.app as {
      listen: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      log: { error: ReturnType<typeof vi.fn> };
    };
    app.listen.mockRejectedValue(
      new Error(
        "postgres://db-user:db-password@localhost/opentag jwt-secret google-secret encryption-secret slack-client-secret slack-signing-secret",
      ),
    );

    await startServer();

    expect(process.exitCode).toBe(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(state.events).not.toContain("ready:listen");
    expect(state.events.slice(-5)).toEqual([
      "app:close",
      "worker:stop",
      "feishu-setup:stop",
      "feishu-connections:stop",
      "sql:end",
    ]);
    const logged = JSON.stringify(app.log.error.mock.calls);
    expect(logged).toContain("Failed to start OpenTag server");
    for (const secret of [
      "postgres://db-user:db-password@localhost/opentag",
      "jwt-secret",
      "google-secret",
      "encryption-secret",
      "slack-client-secret",
      "slack-signing-secret",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
