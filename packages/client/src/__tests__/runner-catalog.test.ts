import { describe, expect, it } from "vitest";
import { linuxAmd64ProviderCliPlans } from "../runner/catalog.js";
import { PROVIDER_CLI_CATALOG } from "../runtime/provider-cli/catalog.js";

describe("runner provider CLI catalog plans", () => {
  it("uses the reviewed catalog as the only Slack and Lark pin", () => {
    const plans = linuxAmd64ProviderCliPlans();
    expect(plans.map((plan) => [plan.provider, plan.version, plan.command])).toEqual([
      ["feishu", "1.0.92", "lark-cli"],
      ["slack", "4.7.0", "slack"],
    ]);
    const slack = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "slack");
    const lark = PROVIDER_CLI_CATALOG.find((entry) => entry.provider === "feishu");
    expect(plans[1]?.artifact.sha256).toBe(
      slack?.artifacts.find((artifact) => artifact.platform === "linux" && artifact.arch === "x64")?.sha256,
    );
    expect(plans[0]?.managedEnvironment).toEqual(lark?.managedEnvironment);
    expect(plans[1]?.managedArguments).toEqual(slack?.managedArguments);
  });
});
