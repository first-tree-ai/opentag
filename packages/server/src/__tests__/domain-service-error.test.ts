import {
  GITHUB_CONNECTION_ERROR_CODES,
  MCP_ERROR_CODES,
  SCHEDULE_ERROR_CODES,
  SKILL_ERROR_CODES,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  RuntimeCapabilityStoreCapacityError,
  RuntimeExecutionBearerStoreCapacityError,
  RuntimeExecutionRegistryCapacityError,
  RuntimeMcpGatewayTokenStoreCapacityError,
  RuntimeProxyTicketStoreCapacityError,
  RuntimeStoreCapacityError,
  RuntimeUrlHandleStoreCapacityError,
  RuntimeValidationRunRegistryCapacityError,
  RuntimeWebGatewayTokenStoreCapacityError,
} from "../runtime-credentials/index.js";
import { AgentServiceError } from "../services/agents/errors.js";
import { AuthServiceError } from "../services/auth/errors.js";
import { DomainServiceError } from "../services/domain-service-error.js";
import { GitHubConnectionServiceError } from "../services/github/errors.js";
import { ImFeedbackServiceError } from "../services/im/im-feedback-actions.js";
import { ImBindingServiceError, ImBindingUnbindRequiredError } from "../services/im-bindings/errors.js";
import { SlackConfigurationServiceError } from "../services/im-bindings/slack/configuration-service.js";
import { McpServiceError } from "../services/mcp/errors.js";
import { OnboardingResetError } from "../services/onboarding-reset/onboarding-reset-service.js";
import {
  CloudCapacityExceededError,
  SandboxServiceError,
  WorkspaceRestoreRequiredError,
  WorkspaceSaveFailedError,
} from "../services/sandboxes/errors.js";
import { ScheduleServiceError } from "../services/schedules/errors.js";
import { AccountSetupServiceError } from "../services/setup/account-setup-service.js";
import { SkillServiceError } from "../services/skills/errors.js";
import { TaskQueryError } from "../services/tasks/task-error.js";

describe("DomainServiceError hierarchy", () => {
  it("unifies all 13 account-facing service error classes and their subclasses under DomainServiceError", () => {
    const cause = new Error("root cause");
    const instances: Array<{
      error: DomainServiceError;
      expectedClass: abstract new (...args: never[]) => DomainServiceError;
      expectedName: string;
    }> = [
      {
        error: new AuthServiceError("RESOURCE_NOT_FOUND", "credential", "Authentication is required", 401),
        expectedClass: AuthServiceError,
        expectedName: "AuthServiceError",
      },
      {
        error: new ImFeedbackServiceError("IM_FEEDBACK_NOT_FOUND", "Feedback not found", 404),
        expectedClass: ImFeedbackServiceError,
        expectedName: "ImFeedbackServiceError",
      },
      {
        error: new AgentServiceError("RESOURCE_NOT_FOUND", "deterministic", "Agent not found", 404),
        expectedClass: AgentServiceError,
        expectedName: "AgentServiceError",
      },
      {
        error: new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "Binding not found", "deterministic", {
          cause,
        }),
        expectedClass: ImBindingServiceError,
        expectedName: "ImBindingServiceError",
      },
      {
        error: new OnboardingResetError(
          "ONBOARDING_RESET_OWNERSHIP_INCONSISTENT",
          409,
          "Reset ownership is inconsistent",
        ),
        expectedClass: OnboardingResetError,
        expectedName: "OnboardingResetError",
      },
      {
        error: new TaskQueryError("TASK_INVALID_CURSOR", "Task cursor is invalid", 400),
        expectedClass: TaskQueryError,
        expectedName: "TaskQueryError",
      },
      {
        error: new SlackConfigurationServiceError(
          "SLACK_CONFIGURATION_NOT_FOUND",
          404,
          "Slack configuration not found",
          "deterministic",
        ),
        expectedClass: SlackConfigurationServiceError,
        expectedName: "SlackConfigurationServiceError",
      },
      {
        error: new AccountSetupServiceError("ACCOUNT_SETUP_AGENT_NOT_FOUND", 404, "Setup agent not found"),
        expectedClass: AccountSetupServiceError,
        expectedName: "AccountSetupServiceError",
      },
      {
        error: new SandboxServiceError("RESOURCE_NOT_FOUND", "deterministic", "Sandbox not found", 404),
        expectedClass: SandboxServiceError,
        expectedName: "SandboxServiceError",
      },
      {
        error: new McpServiceError(
          MCP_ERROR_CODES.SERVER_NOT_FOUND,
          "MCP server not found",
          { serverId: "s1" },
          { cause },
        ),
        expectedClass: McpServiceError,
        expectedName: "McpServiceError",
      },
      {
        error: new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.AGENT_OWNERSHIP_INVALID,
          403,
          "GitHub agent ownership invalid",
          "deterministic",
          { cause },
        ),
        expectedClass: GitHubConnectionServiceError,
        expectedName: "GitHubConnectionServiceError",
      },
      {
        error: new ScheduleServiceError(SCHEDULE_ERROR_CODES.INVALID_REQUEST, "Schedule request is invalid"),
        expectedClass: ScheduleServiceError,
        expectedName: "ScheduleServiceError",
      },
      {
        error: new SkillServiceError(SKILL_ERROR_CODES.NOT_FOUND, "Skill not found"),
        expectedClass: SkillServiceError,
        expectedName: "SkillServiceError",
      },
    ];

    expect(instances).toHaveLength(13);
    for (const { error, expectedClass, expectedName } of instances) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainServiceError);
      expect(error).toBeInstanceOf(expectedClass);
      expect(error.name).toBe(expectedName);
      expect(typeof error.code).toBe("string");
      expect(typeof error.category).toBe("string");
      expect(typeof error.statusCode).toBe("number");
      expect(typeof error.message).toBe("string");
    }

    const unbindError = new ImBindingUnbindRequiredError({
      currentProvider: "slack",
      currentBindingId: "00000000-0000-4000-8000-000000000001",
      requestedProvider: "feishu",
    });
    expect(unbindError).toBeInstanceOf(DomainServiceError);
    expect(unbindError).toBeInstanceOf(ImBindingServiceError);
    expect(unbindError).toBeInstanceOf(ImBindingUnbindRequiredError);
    expect(unbindError.name).toBe("ImBindingUnbindRequiredError");

    const capacityExceeded = new CloudCapacityExceededError("account");
    const restoreRequired = new WorkspaceRestoreRequiredError();
    const saveFailed = new WorkspaceSaveFailedError("Workspace save failed");
    for (const sandboxSubError of [capacityExceeded, restoreRequired, saveFailed]) {
      expect(sandboxSubError).toBeInstanceOf(DomainServiceError);
      expect(sandboxSubError).toBeInstanceOf(SandboxServiceError);
    }
  });
});

describe("RuntimeStoreCapacityError hierarchy", () => {
  it("unifies all runtime credential capacity errors under RuntimeStoreCapacityError", () => {
    const errors = [
      new RuntimeExecutionRegistryCapacityError(),
      new RuntimeProxyTicketStoreCapacityError(),
      new RuntimeUrlHandleStoreCapacityError(),
      new RuntimeValidationRunRegistryCapacityError(),
      new RuntimeCapabilityStoreCapacityError(),
      new RuntimeExecutionBearerStoreCapacityError("The execution bearer store is full"),
      new RuntimeMcpGatewayTokenStoreCapacityError(),
      new RuntimeWebGatewayTokenStoreCapacityError(),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RuntimeStoreCapacityError);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});
