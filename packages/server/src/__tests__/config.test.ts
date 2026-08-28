import { describe, expect, it } from "vitest";
import { isHostedEnvironment, parseDatabaseConfig, parseServerConfig, serverEnvironmentSummary } from "../config.js";

const required = {
  BETTER_AUTH_SECRET: "a-better-auth-secret-of-at-least-32-characters",
  OPENTAG_DATABASE_URL: "postgresql://opentag:opentag@localhost:5432/opentag",
  OPENTAG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPENTAG_JWT_SECRET: "a-secret-that-is-at-least-32-characters",
  OPENTAG_PUBLIC_URL: "http://localhost:8000",
};

describe("parseServerConfig", () => {
  it("offers the staging Onboarding Lab on every staging deployment and its reset only when configured", () => {
    const accountId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: ` ${accountId} `,
      }).stagingOnboardingLab,
    ).toEqual({ accountId });

    // Scenario Preview is fixed client-side fixtures, so staging offers the Lab with no Account
    // configured; only the reset half waits for one.
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: "",
      }).stagingOnboardingLab,
    ).toEqual({});
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
      }).stagingOnboardingLab,
    ).toEqual({});

    expect(parseServerConfig({ ...required, OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: "" }).stagingOnboardingLab).toBe(
      undefined,
    );
    expect(parseServerConfig(required).stagingOnboardingLab).toBe(undefined);
    expect(
      parseServerConfig({ ...required, OPENTAG_ENV: "prod", OPENTAG_PUBLIC_URL: "https://example.com" })
        .stagingOnboardingLab,
    ).toBe(undefined);

    for (const invalid of [
      {
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: accountId,
      },
      { OPENTAG_ENV: "dev", OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: accountId },
      { OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: accountId },
      {
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://staging.example.com",
        OPENTAG_STAGING_ONBOARDING_ACCOUNT_ID: "not-a-uuid",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("applies safe local defaults", () => {
    expect(parseServerConfig(required)).toMatchObject({
      accessTokenTtlSeconds: 900,
      autoMigrate: true,
      environment: "dev",
      host: "127.0.0.1",
      publicUrl: "http://localhost:8000",
      port: 8000,
      observability: {
        tracing: { endpoint: "", environment: "dev", headers: "", sampleRate: 1 },
      },
      refreshTokenTtlSeconds: 2_592_000,
    });
    expect(parseServerConfig(required).devAuth).toBeUndefined();
  });

  it("enables development sign-in only with an explicit existing-user email and loopback server", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: " ADMIN@Example.com ",
        OPENTAG_ENV: "dev",
      }),
    ).toMatchObject({ devAuth: { email: "admin@example.com" }, environment: "dev" });

    for (const invalid of [
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true", OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      { OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true" },
      { OPENTAG_DEV_AUTH_EMAIL: "admin@example.com" },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "staging",
        OPENTAG_PUBLIC_URL: "https://dev.example.com",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://localhost:8000",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_HOST: "0.0.0.0",
      },
      {
        OPENTAG_DEV_AUTH_BYPASS_ENABLED: "true",
        OPENTAG_DEV_AUTH_EMAIL: "admin@example.com",
        OPENTAG_ENV: "dev",
        OPENTAG_PUBLIC_URL: "http://192.0.2.10:8000",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete first-party Slack OAuth configuration and a callback on this origin", () => {
    const slack = {
      OPENTAG_SLACK_CLIENT_ID: "slack-client-id",
      OPENTAG_SLACK_CLIENT_SECRET: "slack-client-secret",
      OPENTAG_SLACK_SIGNING_SECRET: "slack-signing-secret",
      OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    };
    expect(parseServerConfig({ ...required, ...slack }).slackOAuth).toEqual({
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret: "slack-signing-secret",
      redirectUrl: "http://localhost:8000/api/v1/im-bindings/slack/oauth/callback",
    });
    expect(
      parseServerConfig({
        ...required,
        ...slack,
        OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000",
      }).slackOAuth?.redirectUrl,
    ).toBe("http://localhost:8000/api/v1/im-bindings/slack/oauth/callback");
    expect(parseServerConfig(required).slackOAuth).toBeUndefined();
    expect(
      parseServerConfig({ ...required, OPENTAG_SLACK_CLIENT_ID: "", OPENTAG_SLACK_CLIENT_SECRET: "" }).slackOAuth,
    ).toBe(undefined);

    for (const invalid of [
      { OPENTAG_SLACK_CLIENT_ID: "slack-client-id" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "https://evil.example/api/v1/im-bindings/slack/oauth/callback" },
      { ...slack, OPENTAG_SLACK_REDIRECT_URL: "http://localhost:8000/api/v1/auth/google/callback" },
      {
        ...slack,
        OPENTAG_ENV: "prod",
        OPENTAG_PUBLIC_URL: "https://opentag.example.com",
        OPENTAG_SLACK_REDIRECT_URL: "http://opentag.example.com/api/v1/im-bindings/slack/oauth/callback",
      },
    ]) {
      expect(() => parseServerConfig({ ...required, ...invalid })).toThrow();
    }
  });

  it("requires complete Google configuration and HTTPS in hosted environments", () => {
    expect(isHostedEnvironment("dev")).toBe(false);
    expect(isHostedEnvironment("staging")).toBe(true);
    expect(isHostedEnvironment("prod")).toBe(true);
    expect(() => parseServerConfig({ ...required, OPENTAG_GOOGLE_CLIENT_ID: "client" })).toThrow();
    for (const environment of ["staging", "prod"] as const) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
      expect(
        parseServerConfig({
          ...required,
          OPENTAG_ENV: environment,
          OPENTAG_PUBLIC_URL: environment === "staging" ? "https://dev.example.com" : "https://opentag.example.com",
          OPENTAG_GOOGLE_CLIENT_ID: "client",
          OPENTAG_GOOGLE_CLIENT_SECRET: "secret",
        }),
      ).toMatchObject({
        environment,
        google: { clientId: "client", clientSecret: "secret" },
      });
    }
  });

  it("uses OPENTAG_ENV as the channel source without interpreting the hostname", () => {
    const config = parseServerConfig({
      ...required,
      OPENTAG_ENV: "staging",
      OPENTAG_PUBLIC_URL: "https://dev.example.com",
    });
    expect(serverEnvironmentSummary(config)).toEqual({
      binName: "opentag-staging",
      channel: "staging",
      environment: "staging",
      packageName: "open-tag-staging",
      publicUrl: "https://dev.example.com",
    });
  });

  it("rejects legacy or parallel environment values", () => {
    for (const environment of ["development", "production", "test"]) {
      expect(() => parseServerConfig({ ...required, OPENTAG_ENV: environment })).toThrow();
    }
  });

  it("rejects invalid ports, secrets, and database protocols", () => {
    expect(() => parseServerConfig({ ...required, OPENTAG_PORT: "0" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_JWT_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_DATABASE_URL: "https://example.com" })).toThrow();
  });

  it("requires a Better Auth secret that is independent of the legacy JWT secret", () => {
    expect(parseServerConfig(required).betterAuthSecret).toBe(required.BETTER_AUTH_SECRET);
    expect(parseServerConfig(required).betterAuthSecret).not.toBe(parseServerConfig(required).jwtSecret);

    const { BETTER_AUTH_SECRET: _omitted, ...withoutSecret } = required;
    expect(() => parseServerConfig(withoutSecret)).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: "short" })).toThrow();
    expect(() => parseServerConfig({ ...required, BETTER_AUTH_SECRET: required.OPENTAG_JWT_SECRET })).toThrow();
  });

  it("parses optional OTLP tracing configuration and validates its bounds", () => {
    expect(
      parseServerConfig({
        ...required,
        OPENTAG_OTEL_ENDPOINT: "https://logfire-us.pydantic.dev/v1/traces",
        OPENTAG_OTEL_HEADERS: "Authorization=Bearer pylf_test",
        OPENTAG_OTEL_ENVIRONMENT: "production",
        OPENTAG_OTEL_SAMPLE_RATE: "0.25",
      }).observability.tracing,
    ).toEqual({
      endpoint: "https://logfire-us.pydantic.dev/v1/traces",
      headers: "Authorization=Bearer pylf_test",
      environment: "production",
      sampleRate: 0.25,
    });
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_SAMPLE_RATE: "1.1" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "file:///tmp/traces" })).toThrow();
    expect(() => parseServerConfig({ ...required, OPENTAG_OTEL_ENDPOINT: "https://user:pass@example.com" })).toThrow();
  });

  it("allows migration commands to parse only their database dependency", () => {
    expect(parseDatabaseConfig({ OPENTAG_DATABASE_URL: required.OPENTAG_DATABASE_URL })).toMatchObject({
      databaseUrl: required.OPENTAG_DATABASE_URL,
    });
  });
});
