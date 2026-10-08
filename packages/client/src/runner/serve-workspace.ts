import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import type { CloudTurnRunner } from "./cloud-turns.js";
import type { CloudWorkspace } from "./cloud-workspace.js";
import type { NativeSandbox, SandboxProbeResult } from "./native-sandbox.js";

export interface WorkspaceNativeState {
  present: boolean;
  stopping: boolean;
  fatal: boolean;
  probe: SandboxProbeResult;
  active?: { abort: AbortController; done: Promise<void> };
}

/** Serializes the existing native occupation boundary with archive I/O, without another lifecycle. */
export class ServeWorkspace {
  readonly #workspace: CloudWorkspace;
  readonly #sandbox: NativeSandbox;
  readonly #state: () => WorkspaceNativeState;
  readonly #turns: CloudTurnRunner;
  #blocked = true;
  #sealing = false;
  #serial: Promise<unknown> = Promise.resolve();
  #sealInFlight?: Promise<void>;

  constructor(input: {
    workspace: CloudWorkspace;
    sandbox: NativeSandbox;
    state: () => WorkspaceNativeState;
    turns: CloudTurnRunner;
  }) {
    this.#workspace = input.workspace;
    this.#sandbox = input.sandbox;
    this.#state = input.state;
    this.#turns = input.turns;
  }

  get ready(): boolean {
    return !this.#blocked && !this.#sealing && !this.#workspace.sealed && !this.#workspace.pendingSave;
  }

  get sealing(): boolean {
    return this.#sealing;
  }

  async prepare(): Promise<boolean> {
    if (this.#sealing || this.#workspace.sealed || this.#workspace.terminalFailure) return false;
    if (this.#workspace.initialized && !this.#workspace.pendingSave && this.#state().present && !this.#blocked) {
      return true;
    }
    this.#blocked = true;
    // Wait BEFORE taking the persistence queue: the live Turn may itself need that queue to
    // finish its checkpoint. Taking it first would deadlock reconnect against the old Turn.
    await this.#turns.waitForActive();
    await this.#state().active?.done;
    return this.#enqueue(async () => {
      await this.#quiesce();
      await this.#workspace.initialize();
      if (this.#workspace.sealed || this.#sealing || this.#state().stopping) return false;
      await this.#launch();
      this.#blocked = false;
      return true;
    });
  }

  checkpoint(): Promise<void> {
    this.#blocked = true;
    return this.#enqueue(async () => {
      await this.#quiesce();
      await this.#workspace.save();
      await this.#launch();
      this.#blocked = this.#sealing || this.#state().stopping;
    });
  }

  seal(): Promise<void> {
    if (this.#sealInFlight) return this.#sealInFlight;
    this.#blocked = true;
    this.#sealing = true;
    const run = this.#seal().finally(() => {
      this.#sealInFlight = undefined;
    });
    this.#sealInFlight = run;
    return run;
  }

  async #seal(): Promise<void> {
    this.#state().active?.abort.abort();
    await this.#state().active?.done;
    await this.#turns.drainForRelease(RUNNER_WORKSPACE_TIMEOUT_MS);
    await this.#enqueue(async () => {
      await this.#quiesce();
      await this.#workspace.save(true);
    });
    // Remain sealed on this allocation. Only a new environment restores and resumes execution.
  }

  async #quiesce(): Promise<void> {
    const state = this.#state();
    if (!state.present) return;
    try {
      await this.#sandbox.destroy();
      state.present = false;
    } catch (error) {
      state.fatal = true;
      throw error;
    }
  }

  async #launch(): Promise<void> {
    const state = this.#state();
    if (this.#sealing || state.stopping) return;
    state.present = true;
    try {
      await this.#sandbox.launch();
      state.probe = await this.#sandbox.probe();
    } catch (error) {
      state.fatal = true;
      throw error;
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#serial.then(operation, operation);
    this.#serial = pending.catch(() => undefined);
    return pending;
  }
}
