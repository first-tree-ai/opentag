import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "e2e/package.json"));
// biome-ignore lint/correctness/noUndeclaredDependencies: Resolved from the E2E workspace, which declares this dependency.
const { chromium, expect } = require("@playwright/test");
// biome-ignore lint/correctness/noUndeclaredDependencies: Resolved from the E2E workspace, which declares this dependency.
const { AxeBuilder } = require("@axe-core/playwright");
const output = resolve(root, "testing/web-ui/agent-status/output");
const baselineFile = resolve(root, "apps/web/src/features/agents/status-validation-baseline.tsx");
const entryFile = resolve(root, "apps/web/status-validation.tsx");
const htmlFile = resolve(root, "apps/web/status-validation.html");
const configFile = resolve(root, "apps/web/status-validation.config.ts");
const port = Number(process.env.OPENTAG_STATUS_REVIEW_PORT ?? 5179);
const baselineRef = process.env.OPENTAG_STATUS_BASELINE_REF ?? "2d24de50f09da8048b11dd8a499fce209ee2cec6";

// The original healthy card is rendered alongside the changed component, with the same real CSS.
const baseline = execFileSync("git", ["show", `${baselineRef}:apps/web/src/features/agents/agent-detail-page.tsx`], {
  cwd: root,
  encoding: "utf8",
});
assert.match(baseline, /export function AgentStatusCard/);
const entry = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentStatusCard } from "./src/features/agents/agent-status-card.js";
import { AgentStatusCard as Baseline } from "./src/features/agents/status-validation-baseline.js";
import { projectAgentAvailability } from "./src/features/agents/agent-model.js";
import { TooltipProvider } from "./src/ui/design-system.js";
import { overwriteGetLocale } from "./src/paraglide/runtime.js";
import "./src/app.css";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const now = "2026-10-21T00:00:00.000Z";
function sample(s = {}) {
  const agent = {id:agentId,name:s.longName ? "a-very-long-messaging-bot-identity-for-layout-validation" : "opentag",displayName:"openTag",createdBy:{userId:agentId,displayName:"Ada"},computer:s.unbound?null:{computerId,displayName:s.shortName?"Ada's Mac":s.longName?"Studio-MacBook-Pro.local-with-a-very-long-computer-name":"Studio-MacBook-Pro.local",platform:"darwin"},runtimeProvider:s.provider??"codex",receiveMode:"mention_only",status:s.paused?"suspended":"active",activity:{state:"idle"},createdAt:now,updatedAt:now};
  const computer = s.computerUnknown?undefined:{computerId,kind:"local",displayName:agent.computer?.displayName,platform:"darwin",connectionStatus:s.offline?"offline":"online",providerReadiness:s.runtime===null?[]:[{provider:agent.runtimeProvider,status:s.runtime??"ready",observedAt:now}],connectedAt:now,lastSeenAt:now,observedAt:now,createdAt:now,agentIds:[agentId]};
  const binding=s.noMessaging?undefined:{id:computerId,agentId,provider:"feishu",bindingState:s.binding??"active",bot:{displayName:"openTag",avatarUrl:null},receiveMode:"mention_only",lastInboundAt:null,lastValidatedAt:now,lastRuntimeObservationAt:now};
  const handoff=binding?{bindingState:binding.bindingState,handoffReady:!s.handoffFailure&&!s.phase,...(s.phase?{providerCli:{phase:s.phase}}:{})}:undefined;
  return {...agent,computerKind:"local",availability:projectAgentAvailability(agent,computer,binding,handoff,!s.messagingUnknown,!s.messagingUnknown),messaging:s.messagingUnknown?{kind:"unconfirmed"}:{kind:"ready",value:binding}};
}
function Harness(){
  const [scenario,setScenario]=useState({id:"ready"});
  window.statusReview={set:(s)=>{overwriteGetLocale(()=>s.locale??"en");setScenario(s);}};
  return <main style={{padding:24,maxWidth:560,margin:"auto"}}>
    <div data-testid="baseline"><Baseline agent={sample({shortName:true})}/></div>
    <div data-testid="current" data-case={scenario.id} style={{marginTop:24}}><AgentStatusCard agent={sample(scenario)}/></div>
  </main>;
}
const route=createRootRoute({component:Harness});
const router=createRouter({routeTree:route,history:createMemoryHistory({initialEntries:["/"]})});
createRoot(document.getElementById("root")).render(<TooltipProvider><RouterProvider router={router}/></TooltipProvider>);
`;
const cases = [
  { id: "ready" },
  ...["checking", "install", "sign-in", "unavailable", null].map((runtime) => ({ id: `runtime-${runtime}`, runtime })),
  { id: "offline", offline: true, runtime: "sign-in" },
  { id: "computer-unknown", computerUnknown: true, runtime: "unavailable" },
  { id: "unbound", unbound: true, noMessaging: true },
  { id: "no-messaging", noMessaging: true },
  ...["provisioning", "reauthorization_required", "error", "disabled"].map((binding) => ({
    id: `binding-${binding}`,
    binding,
  })),
  ...["preparing_cli", "checking_credentials", "needs_attention"].map((phase) => ({ id: `handoff-${phase}`, phase })),
  { id: "handoff-failed", handoffFailure: true },
  { id: "messaging-unknown", messagingUnknown: true },
  { id: "paused-runtime", paused: true, runtime: "unavailable" },
  { id: "long-names", longName: true },
  ...["claude-code", "pi"].flatMap((provider) =>
    ["checking", "install", "sign-in", "unavailable", null].map((runtime) => ({
      id: `${provider}-${runtime}`,
      provider,
      runtime,
      longName: true,
    })),
  ),
];

await mkdir(output, { recursive: true });
let browser;
let server;
try {
  await writeFile(baselineFile, baseline);
  await writeFile(entryFile, entry);
  await writeFile(
    htmlFile,
    '<!doctype html><html lang="en" data-opentag-theme="opentag" data-opentag-mode="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent status validation</title></head><body><div id="root"></div><script type="module" src="/status-validation.tsx"></script></body></html>',
  );
  await writeFile(
    configFile,
    `import { mergeConfig } from "vite";
import config from "./vite.config.js";
// The fixture bundles both revisions; application entry budgets are checked by the normal Web build.
export default mergeConfig({...config, plugins: config.plugins.filter(plugin => plugin?.name !== "opentag-bundle-budget")}, { build: { outDir: ${JSON.stringify(resolve(output, "site"))}, emptyOutDir: true, rollupOptions: { input: ${JSON.stringify(htmlFile)} } } });`,
  );
  const build = execFileSync("pnpm", ["--filter", "@opentag/web", "exec", "vite", "build", "--config", configFile], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VITEST: "true" },
    maxBuffer: 16 * 1024 * 1024,
  });
  await writeFile(resolve(output, "build.log"), build);
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    const path = resolve(output, "site", `.${pathname}`);
    if (!path.startsWith(`${resolve(output, "site")}/`)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(path);
      res
        .writeHead(200, { "content-type": mime[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream" })
        .end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/status-validation.html`);
  await page.waitForFunction(() => Boolean(window.statusReview));
  await page.evaluate(() => document.fonts.ready);
  const measurements = [];
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ["en", "zh"]) {
      for (const scenario of cases) {
        await page.evaluate((s) => window.statusReview.set(s), { ...scenario, locale });
        const current = page.locator(`[data-testid="current"][data-case="${scenario.id}"]`);
        await current.waitFor();
        const geometry = await current.locator('[data-ui="agent-status-overview"]').evaluate((card) => {
          const box = card.getBoundingClientRect();
          const rows = [...card.querySelectorAll("li")];
          const baselineCard = document.querySelector('[data-testid="baseline"] [data-ui="agent-status-overview"]');
          return {
            height: box.height,
            baselineHeight: baselineCard.getBoundingClientRect().height,
            divider: rows[1].getBoundingClientRect().top - box.top,
            rows: rows.length,
            provider: card.querySelector('[data-ui="agent-status-provider"]').getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            labels: [...card.querySelectorAll('[data-ui="agent-status-label"]')].map((label) => ({
              text: label.textContent,
              width: label.clientWidth,
              contentWidth: label.scrollWidth,
              insideRow: label.getBoundingClientRect().right <= label.closest("li").getBoundingClientRect().right,
            })),
            targets: rows.map((row) => row.querySelector("a, button").getBoundingClientRect().height),
          };
        });
        assert.equal(geometry.rows, 2, `${width}/${locale}/${scenario.id}: row count`);
        assert.equal(geometry.height, geometry.baselineHeight, `${width}/${locale}/${scenario.id}: healthy height`);
        assert(geometry.provider > 0, `${width}/${locale}/${scenario.id}: provider visible`);
        assert.equal(geometry.overflow, false, `${width}/${locale}/${scenario.id}: page overflow`);
        assert(
          geometry.targets.every((height) => height >= 44),
          `${width}/${locale}/${scenario.id}: touch targets`,
        );
        assert(
          geometry.labels.every((label) => label.contentWidth <= label.width && label.insideRow),
          `${width}/${locale}/${scenario.id}: complete status labels: ${JSON.stringify(geometry.labels)}`,
        );
        measurements.push({ width, locale, scenario: scenario.id, ...geometry });
      }
      const group = measurements.filter((m) => m.width === width && m.locale === locale);
      assert.equal(new Set(group.map((m) => m.divider)).size, 1, `${width}/${locale}: divider moves`);
      await page.evaluate((s) => window.statusReview.set(s), { id: "ready", locale, longName: true });
      const current = page.locator('[data-testid="current"][data-case="ready"]');
      await current.waitFor();
      const trigger = current.locator('[data-ui="agent-status-computer"] button');
      const closedGeometry = await current.locator('[data-ui="agent-status-overview"]').boundingBox();
      await trigger.click();
      await page.getByRole("dialog").waitFor();
      assert.deepEqual(
        await current.locator('[data-ui="agent-status-overview"]').boundingBox(),
        closedGeometry,
        "Details do not move or resize the card",
      );
      assert.match(
        await page.getByRole("dialog").innerText(),
        /Studio-MacBook-Pro.local-with-a-very-long-computer-name/,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await expect(trigger).toBeFocused();
      const violations = (await new AxeBuilder({ page }).include('[data-testid="current"]').analyze()).violations;
      assert.deepEqual(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.failureSummary).join("; ")}`),
        [],
        `${width}/${locale}: axe`,
      );
      await page.evaluate((s) => window.statusReview.set(s), {
        id: "runtime-unavailable",
        locale,
        runtime: "unavailable",
      });
      await page.locator('[data-testid="current"][data-case="runtime-unavailable"]').waitFor();
      const actionableViolations = (await new AxeBuilder({ page }).include('[data-testid="current"]').analyze())
        .violations;
      assert.deepEqual(
        actionableViolations.map((v) => v.id),
        [],
        `${width}/${locale}: actionable axe`,
      );
      await page
        .locator('[data-testid="current"]')
        .screenshot({ path: resolve(output, `status-${locale}-${width}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", resolve(output, "measurements.json")], { cwd: root });
  console.log(
    `${measurements.length} state/locale/width comparisons passed against the original healthy card; popover, focus, 44px targets and axe passed.`,
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(resolve(output, "site"), { recursive: true, force: true });
  await Promise.all([baselineFile, entryFile, htmlFile, configFile].map((path) => rm(path, { force: true })));
}
