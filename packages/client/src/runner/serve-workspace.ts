import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import type { CloudTurnRunner } from "./cloud-turns.js";
import type { CloudWorkspace } from "./cloud-workspace.js";
import type { NativeSandbox, SandboxProbeResult } from "./native-sandbox.js";

export interface WorkspaceNativeState {
  /** Possibly present until a verified `delete --force` succeeds; never an exact observation. */
  present: boolean;
  stopping: boolean;
  fatal: boolean;
  /** Fresh proof of the current namespace; cleared on destruction or a new launch. */
  probe?: SandboxProbeResult;
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
      // A stop (or a seal) that landed during the launch left no fresh probe: never admit work
      // or report readiness for an unproven namespace.
      if (this.#state().stopping || this.#state().probe === undefined) return false;
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
    // A fresh parent also verifies deletion: no local launch does not rule out a crash residual.
    if (!state.present) return;
    try {
      await this.#sandbox.destroy();
      state.present = false;
      // The destroyed namespace's probe is stale evidence from this point on.
      state.probe = undefined;
    } catch (error) {
      state.fatal = true;
      throw error;
    }
  }

  async #launch(): Promise<void> {
    const state = this.#state();
    if (this.#sealing || state.stopping) return;
    // Set before the launch so a failed or partial namespace is still deleted by cleanup.
    state.present = true;
    // A replacement namespace must supply its own fresh readiness proof.
    state.probe = undefined;
    try {
      await this.#sandbox.launch();
      // A stop that arrived during the launch skips the probe; the launched namespace stays
      // tracked by `present` for verified cleanup.
      if (state.stopping) return;
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
