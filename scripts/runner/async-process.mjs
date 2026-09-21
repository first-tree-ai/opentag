#!/usr/bin/env node

/**
 * Interruptible async process execution for the Runner harness. `spawnSync` blocks the event
 * loop, so SIGTERM/SIGINT handlers could not fire for up to the full command timeout; every
 * long operation here is an owned async child that the signal path kills before cleanup runs.
 */

import { spawn } from "node:child_process";
import { registerEmergencyHook } from "./cleanup.mjs";

const activeChildren = new Set();
let emergencyInstalled = false;

function killOwnedTree(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function installEmergencyHook() {
  if (emergencyInstalled) return;
  emergencyInstalled = true;
  registerEmergencyHook(() => {
    for (const child of [...activeChildren]) {
      killOwnedTree(child);
    }
  });
}

export function countActiveChildren() {
  return activeChildren.size;
}

/**
 * Runs one command to completion with a hard timeout. On timeout the child is SIGKILLed and the
 * promise rejects; on process signals the emergency hook SIGKILLs every tracked child.
 */
export function runProcess(command, args, options = {}) {
  const { timeoutMs = 15 * 60 * 1000, input } = options;
  installEmergencyHook();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killOwnedTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) {
        killOwnedTree(child);
        finish(new Error(`${command} exceeded the stdout capture bound`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8 * 1024 * 1024) stderr = stderr.slice(-8 * 1024 * 1024);
    });
    const finish = (error, status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeChildren.delete(child);
      if (error) reject(error);
      else if (timedOut) reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
      else resolve({ status, signal, stdout, stderr });
    };
    child.on("error", (error) => finish(error));
    child.on("close", (status, signal) => {
      if (timedOut) finish(undefined);
      else if (signal) finish(new Error(`${command} ${args.join(" ")} was killed by ${signal}`));
      else finish(undefined, status, signal);
    });
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}
