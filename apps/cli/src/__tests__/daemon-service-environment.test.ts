import { describe, expect, it } from "vitest";
import { preserveLaunchdEnvironment, preserveSystemdEnvironment } from "../core/daemon/service/environment.js";
import { renderLaunchdPlist } from "../core/daemon/service/launchd.js";
import { extractSystemdHome, renderSystemdUnit } from "../core/daemon/service/systemd.js";

const unit = renderSystemdUnit({
  home: "/new/home",
  invocation: { program: "/new/bin/opentag", args: [] },
  path: "/new/path",
  serviceId: "opentag",
});
const plist = renderLaunchdPlist({
  home: "/new/home",
  label: "opentag",
  path: "/new/path",
  stdoutPath: "/log/out",
  stderrPath: "/log/err",
  wrapperPath: "/new/wrapper",
});

describe("service environment preservation", () => {
  it("keeps systemd token quoting, dollar literals, environment files and multiline assignments across repeated refreshes", () => {
    const custom = [
      'Environment="CLAUDE_CODE_OAUTH_TOKEN=synthetic-$&-$`-token"',
      "EnvironmentFile=-%h/.private/claude.env",
      'Environment="CUSTOM=one" \\',
      "# keep the continuation across comments",
      ' "SECOND=two"',
      "PassEnvironment=EXTERNAL",
      "UnsetEnvironment=REMOVED",
    ].join("\n");
    const installed = unit
      .replace('Environment="PATH=', () => `${custom}\nEnvironment="PATH=`)
      .replace("/new/bin/opentag", "/old/bin/opentag");
    const merged = preserveSystemdEnvironment(unit, installed);
    expect(merged).toContain(custom);
    expect(merged).toContain("/new/bin/opentag");
    expect(merged).not.toContain("/old/bin/opentag");
    expect(preserveSystemdEnvironment(unit, merged)).toBe(merged);
  });

  it("ends a systemd environment continuation at a blank line before the next section", () => {
    const custom = 'Environment="CLAUDE_CODE_OAUTH_TOKEN=synthetic-token" \\\n\n';
    const installed = unit.replace("[Install]", () => `${custom}[Install]`);
    const merged = preserveSystemdEnvironment(unit, installed);
    expect(merged).toContain(custom);
    expect(preserveSystemdEnvironment(unit, merged)).toBe(merged);
  });

  it("keeps custom combined assignments while applying OpenTag-owned environment keys last", () => {
    const installed =
      '[Unit]\nEnvironment="WRONG_SECTION=ignored"\n[Service]\nEnvironment="OPENTAG_HOME=/old" "CUSTOM=yes"\nEnvironment="PATH=/old"\nEnvironment=\nEnvironment="TOKEN=last"\n[Install]\nEnvironment="ALSO_IGNORED=yes"\n';
    const merged = preserveSystemdEnvironment(unit, installed);
    expect(merged).toContain('Environment="OPENTAG_HOME=/old" "CUSTOM=yes"');
    expect(merged.indexOf('Environment="OPENTAG_HOME=/new/home"')).toBeGreaterThan(
      merged.indexOf('Environment="OPENTAG_HOME=/old"'),
    );
    expect(extractSystemdHome(merged)).toBe("/new/home");
    expect(merged).not.toContain('Environment="PATH=/old"');
    expect(merged).not.toContain("WRONG_SECTION");
    expect(merged).not.toContain("ALSO_IGNORED");
    expect(preserveSystemdEnvironment(unit, undefined)).toBe(unit);
  });

  it.each(['[Service]\nEnvironment="TOKEN=value" \\', '[Service]\nEnvironment="TOKEN=value" \\\n[Install]'])(
    "rejects unfinished systemd environment continuations before a rewrite",
    (installed) => {
      expect(() => preserveSystemdEnvironment(unit, installed)).toThrow("unfinished continuation");
    },
  );

  it("keeps launchd credential values and XML entities while updating managed keys", () => {
    const custom =
      "<key>CLAUDE_CODE_OAUTH_TOKEN</key><string>synthetic&amp;&quot;$&amp;</string>\n<key>EMPTY</key><string/>";
    const installed = plist
      .replace("<key>PATH</key>", () => `${custom}\n<key>PATH</key>`)
      .replace("/new/home", "/old/home");
    const merged = preserveLaunchdEnvironment(plist, installed);
    expect(merged).toContain("<key>CLAUDE_CODE_OAUTH_TOKEN</key><string>synthetic&amp;&quot;$&amp;</string>");
    expect(merged).toContain("<key>EMPTY</key><string/>");
    expect(merged).toContain("/new/home");
    expect(merged).not.toContain("/old/home");
    expect(preserveLaunchdEnvironment(plist, merged)).toBe(merged);
    expect(preserveLaunchdEnvironment(plist, undefined)).toBe(plist);
  });

  it.each([
    "<key>EnvironmentVari&#97;bles</key><dict><key>TOKEN</key><integer>7</integer></dict>",
    "<key>EnvironmentVariables</key><dict><key>TOKEN</key><integer>7</integer></dict>",
    "<key>EnvironmentVariables</key><array/>",
    "<key>EnvironmentVariables</key><dict><key>TOKEN</key><string>one</string><key>TOKEN</key><string>two</string></dict>",
    "<key>EnvironmentVariables</key><dict></dict><key>EnvironmentVariables</key><dict></dict>",
    "<key>EnvironmentVariables</key><dict></dict><key>EnvironmentVari&#97;bles</key><dict></dict>",
    "<key><![CDATA[EnvironmentVariables]]></key><dict></dict>",
    "bplist00unsupported-binary-plist",
    '<?xml version="1.0" encoding="ISO-8859-1"?><plist><dict/></plist>',
    Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-16"?><plist><dict/></plist>', "utf16le").toString("utf8"),
  ])("refuses a launchd environment it cannot preserve without ambiguity", (installed) => {
    expect(() => preserveLaunchdEnvironment(plist, installed)).toThrow("cannot be safely preserved");
  });

  it.each(["EnvironmentVari&#97;bles", "EnvironmentVari&#x61;bles", "EnvironmentVariables"])(
    "preserves credentials under semantically equivalent environment keys: %s",
    (key) => {
      const installed = plist
        .replace("<key>EnvironmentVariables</key>", `<key >${key}</key >`)
        .replace("<key>PATH</key>", "<key>TOKEN</key><string>synthetic&amp;token</string><key>P&#65;TH</key>");
      const merged = preserveLaunchdEnvironment(plist, installed);
      expect(merged).toContain("<key>TOKEN</key><string>synthetic&amp;token</string>");
      expect(merged).not.toContain("<key>P&#65;TH</key>");
      expect(preserveLaunchdEnvironment(plist, merged)).toBe(merged);
    },
  );

  it.each([
    ["A&amp;B", "A&#38;B"],
    ["A&lt;B", "A&#x3c;B"],
    ["A&gt;B", "A&#62;B"],
    ["A&quot;B", "A&#34;B"],
    ["A&apos;B", "A&#39;B"],
  ])("rejects duplicate decoded keys %s and %s", (first, second) => {
    const installed = plist.replace(
      "<key>PATH</key>",
      `<key>${first}</key><string>one</string><key>${second}</key><string>two</string><key>PATH</key>`,
    );
    expect(() => preserveLaunchdEnvironment(plist, installed)).toThrow("cannot be safely preserved");
  });

  it.each(["&unknown;", "&amp", "&#0;", "&#X41;", "&#xD800;", "&#x110000;", "&#xFFFE;", "\u0001", "\ud800"])(
    "rejects malformed entities in keys and credential values: %s",
    (entity) => {
      for (const entry of [
        `<key>${entity}</key><string>token</string>`,
        `<key>TOKEN</key><string>${entity}</string>`,
      ]) {
        const installed = plist.replace("<key>PATH</key>", `${entry}<key>PATH</key>`);
        expect(() => preserveLaunchdEnvironment(plist, installed)).toThrow("cannot be safely preserved");
      }
    },
  );
});
