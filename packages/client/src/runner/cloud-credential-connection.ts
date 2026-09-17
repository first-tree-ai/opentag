import {
  type RunnerClientFrame,
  RuntimeCredentialClientFrameSchema,
  type RuntimeCredentialServerFrame,
} from "@opentag/shared";
import type { RuntimeBusinessFrame, RuntimeConnection, RuntimeConnectionState } from "../runtime/runtime-connection.js";

/**
 * Adapter that lets the #633 trusted Relay (`RuntimeCredentialRelay`) speak its existing control
 * protocol over the E3 Runner channel: each credential frame rides inside a `credential:frame`
 * tunnel message on the authenticated, per-Sandbox Runner WebSocket. No Local runtime connection,
 * no Computer registry entry — the Server fences these frames with the exact per-attach Cloud
 * connection record. The data plane is unchanged: the relay still dials the ticket-authenticated
 * provider-proxy WebSocket directly.
 */
export interface CloudCredentialChannel {
  /** Send one runner-protocol frame; must throw when the channel is not writable. */
  sendFrame(frame: RunnerClientFrame): void;
  /** Subscribe to server credential tunnel frames. Returns unsubscribe. */
  onCredentialFrame(listener: (frame: RuntimeCredentialServerFrame) => void): () => void;
  /** Subscribe to channel liveness: "registered" while the Runner connection is current. */
  onChannelState(listener: (state: "registered" | "closed") => void): () => void;
}

export class CloudCredentialConnection {
  readonly #channel: CloudCredentialChannel;
  readonly #businessListeners = new Set<(frame: RuntimeBusinessFrame) => void | Promise<void>>();
  readonly #stateListeners = new Set<(state: RuntimeConnectionState) => void>();
  readonly #unsubscribers: (() => void)[];

  constructor(channel: CloudCredentialChannel) {
    this.#channel = channel;
    this.#unsubscribers = [
      channel.onCredentialFrame((frame) => {
        for (const listener of [...this.#businessListeners]) void listener(frame as RuntimeBusinessFrame);
      }),
      channel.onChannelState((state) => {
        const mapped: RuntimeConnectionState = state === "registered" ? "registered" : "stopped";
        for (const listener of [...this.#stateListeners]) listener(mapped);
      }),
    ];
  }

  /** The exact surface `RuntimeCredentialRelayOptions.connection` requires. */
  get relayConnection(): Pick<RuntimeConnection, "send" | "subscribeBusinessFrames" | "subscribeState"> {
    return {
      send: (frame) => this.send(frame),
      subscribeBusinessFrames: (listener) => this.subscribeBusinessFrames(listener),
      subscribeState: (listener) => this.subscribeState(listener),
    };
  }

  send(frame: unknown): Promise<void> {
    const parsed = RuntimeCredentialClientFrameSchema.parse(frame);
    const tunnel: RunnerClientFrame = { type: "credential:frame", frame: parsed };
    this.#channel.sendFrame(tunnel);
    return Promise.resolve();
  }

  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void | Promise<void>): () => void {
    this.#businessListeners.add(listener);
    return () => this.#businessListeners.delete(listener);
  }

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#businessListeners.clear();
    this.#stateListeners.clear();
  }
}
