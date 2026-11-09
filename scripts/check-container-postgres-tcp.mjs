#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { LineCounter, parseDocument, visit } from "yaml";

const DYNAMIC = "\0";
const DOCKER_VALUE_OPTIONS = new Set([
  "-e",
  "--env",
  "--env-file",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--detach-keys",
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--profile",
  "--name",
  "--network",
  "--network-alias",
  "--publish",
  "--volume",
  "-v",
  "--mount",
  "--entrypoint",
  "--health-cmd",
  "--health-interval",
  "--health-timeout",
  "--health-retries",
  "--health-start-period",
  "--label",
  "--hostname",
]);
const POSTGRES_VALUE_OPTIONS = new Set([
  "-c",
  "--command",
  "-d",
  "--dbname",
  "-f",
  "--file",
  "-U",
  "--username",
  "-v",
  "--set",
  "--variable",
  "-o",
  "--output",
  "-p",
  "--port",
  "--timeout",
]);

function hasTcpHost(args, command) {
  let host;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (["--help", "--version", "-V", "-?"].includes(arg)) return true;
    if (arg === "-h" || arg === "--host") host = args[++index];
    else if (arg.startsWith("--host=")) host = arg.slice(7);
    else if (/^-h.+/u.test(arg)) host = arg.slice(2);
    else if (takesPostgresValue(arg, command)) index += 1;
  }
  return isTcpHost(host);
}

function takesPostgresValue(arg, command) {
  return POSTGRES_VALUE_OPTIONS.has(arg) || (command === "pg_isready" && arg === "-t");
}

function isTcpHost(host) {
  return Boolean(host) && !host.startsWith("-") && !/[/@]/u.test(host);
}

function shellCommands(source) {
  // Split simple shell commands without treating quoted text, comments, or continuations as commands.
  const tokens =
    source.match(/\\\r?\n|#[^\n]*|(?:'[^']*'|"(?:\\.|[^"\\])*"|\\[^\r\n]|[^\s'"\\;&|()<>])+|[;&|()\n<>]/gu) ?? [];
  const commands = [[]];
  for (const token of tokens) {
    if (token.startsWith("#") || /^\\\r?\n$/u.test(token)) continue;
    if (/^[;&|()\n<>]$/u.test(token)) commands.push([]);
    else
      commands
        .at(-1)
        .push(
          token.replace(
            /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gsu,
            (_match, single, double, escaped) => single ?? double?.replace(/\\(["\\$`])/gu, "$1") ?? escaped,
          ),
        );
  }
  return commands;
}

function commandStart(args) {
  let index = 0;
  while (
    index < args.length &&
    (/^(?:if|then|do|while|until|!|sudo|exec|env)$/u.test(args[index]) || /^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[index]))
  )
    index += 1;
  return args.slice(index);
}

function afterDockerOptions(args) {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    if (args[index] === "--") return args.slice(index + 1);
    index += DOCKER_VALUE_OPTIONS.has(args[index]) ? 2 : 1;
  }
  return args.slice(index);
}

function inspectCommand(input, inContainer, report) {
  const args = commandStart(input);
  const command = basename(args[0] ?? "");
  if (inContainer && (command === "psql" || command === "pg_isready")) {
    if (!hasTcpHost(args.slice(1), command)) report(command);
    return;
  }
  if (inContainer && ["sh", "bash"].includes(command) && /^-[a-z]*c[a-z]*$/u.test(args[1] ?? "")) {
    inspectShell(args[2] ?? "", true, report);
  }
  if (command !== "docker") return;
  inspectDocker(args.slice(1), report);
}

function inspectShell(source, inContainer, report) {
  for (const args of shellCommands(source)) inspectCommand(args, inContainer, report);
}

function inspectDocker(args, report) {
  const operation = args.findIndex((arg) => ["compose", "exec", "run"].includes(arg));
  if (operation < 0) return;
  if (args[operation] === "compose") return inspectDocker(afterDockerOptions(args.slice(operation + 1)), report);
  const tail = args.slice(operation + 1);
  const [target, ...command] = afterDockerOptions(tail);
  const options = tail.slice(0, tail.length - command.length - 1);
  inspectHealthOptions(options, report);
  if (target) inspectCommand(command, true, report);
}

function inspectHealthOptions(options, report) {
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--health-cmd") inspectShell(options[index + 1] ?? "", true, report);
    if (options[index].startsWith("--health-cmd=")) inspectShell(options[index].slice(13), true, report);
  }
}

function walk(node, callback) {
  if (!node || typeof node.type !== "string") return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, callback);
    } else if (value && typeof value === "object") walk(value, callback);
  }
}

function literal(node) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return DYNAMIC;
}

function arrayWords(node) {
  return node?.type === "ArrayExpression" ? node.elements.map(literal) : null;
}

function dockerArgument(node, wrappers) {
  if (node.type !== "CallExpression") return null;
  if (basename(literal(node.arguments[0])) === "docker") return { argument: node.arguments[1], prefix: [] };
  const wrapper = wrappers.get(node.callee.name);
  return wrapper ? { argument: node.arguments[wrapper.index], prefix: wrapper.prefix } : null;
}

function forwardedParameter(fn, { argument, prefix }) {
  const elements = argument?.type === "ArrayExpression" ? argument.elements : [];
  const spread = elements.findIndex((element) => element?.type === "SpreadElement");
  const parameter = spread < 0 ? argument : elements[spread].argument;
  const index = fn.params.findIndex((param) => param.type === "Identifier" && param.name === parameter?.name);
  return index < 0 ? null : { index, prefix: [...prefix, ...elements.slice(0, Math.max(0, spread)).map(literal)] };
}

function dockerWrappers(ast) {
  const functions = [];
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration") functions.push(node);
  });
  const wrappers = new Map();
  // Follow local argv-forwarding helpers such as run(args) and start(name, args).
  for (let pass = 0; pass < functions.length; pass += 1) {
    let changed = false;
    for (const fn of functions) {
      if (!fn.id || wrappers.has(fn.id.name)) continue;
      walk(fn.body, (node) => {
        const call = dockerArgument(node, wrappers);
        if (!call) return;
        const forwarded = forwardedParameter(fn, call);
        if (!forwarded) return;
        wrappers.set(fn.id.name, forwarded);
        changed = true;
      });
    }
    if (!changed) break;
  }
  return wrappers;
}

function inspectSource(path, source, report) {
  const plugins = [];
  if (/\.[cm]?tsx?$/u.test(path)) plugins.push("typescript");
  if (/\.(?:jsx?|tsx)$/u.test(path)) plugins.push("jsx");
  const ast = parse(source, { sourceType: "unambiguous", plugins, attachComment: false });
  const wrappers = dockerWrappers(ast);
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const atCall = (command) => report(node.loc.start.line, command);
    const call = dockerArgument(node, wrappers);
    if (call) {
      const args = arrayWords(call.argument);
      if (args) inspectDocker([...call.prefix, ...args], atCall);
    } else if (/^exec(?:Sync|Async)?$/u.test(node.callee.name ?? "")) {
      inspectShell(literal(node.arguments[0]), false, atCall);
    }
  });
}

function inspectYaml(source, report) {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter });
  if (document.errors.length > 0) throw document.errors[0];
  visit(document, {
    Pair(_key, pair, ancestors) {
      const key = pair.key?.value;
      const line = lineCounter.linePos(pair.value?.range?.[0] ?? 0).line;
      const atValue = (command) => report(line, command);
      if (key === "run" && typeof pair.value?.value === "string") inspectShell(pair.value.value, false, atValue);
      if (isServiceOptions(key, ancestors) && typeof pair.value?.value === "string") {
        for (const options of shellCommands(pair.value.value)) inspectHealthOptions(options, atValue);
      }
      if (key === "healthcheck") inspectHealthcheck(pair.value?.toJSON()?.test, atValue);
    },
  });
}

function inspectHealthcheck(test, report) {
  if (typeof test === "string") inspectShell(test, true, report);
  else if (test?.[0] === "CMD-SHELL") inspectShell(test[1], true, report);
  else if (test?.[0] === "CMD") inspectCommand(test.slice(1), true, report);
}

function isServiceOptions(key, ancestors) {
  return key === "options" && ancestors.some((ancestor) => ancestor.key?.value === "services");
}

export function checkContainerPostgresTcp(path, source) {
  const violations = [];
  const report = (line, command) =>
    violations.push(`${path}:${line}: container ${command} requires -h/--host with a TCP host`);
  if (!/\b(?:psql|pg_isready)\b/u.test(source)) return violations;
  try {
    if (/\.[cm]?[jt]sx?$/u.test(path)) inspectSource(path, source, report);
    else if (/\.ya?ml$/u.test(path)) inspectYaml(source, report);
    else if (extname(path) === ".sh") inspectShell(source, false, (command) => report(1, command));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return violations;
}

export function checkRepository(root) {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  return paths
    .filter((path) => /\.(?:[cm]?[jt]sx?|ya?ml|sh)$/u.test(path))
    .filter((path) => existsSync(join(root, path)))
    .flatMap((path) => checkContainerPostgresTcp(path, readFileSync(join(root, path), "utf8")));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const violations = checkRepository(process.cwd());
    if (violations.length > 0) throw new Error(violations.join("\n"));
    console.log("Container PostgreSQL TCP check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
