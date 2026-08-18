import type WebSocket from "ws";

export interface RuntimeConnectionEntry {
  computerId: string;
  instanceId: string;
  lastHeartbeatAt: number;
  socket: WebSocket;
  userId: string;
}

export class ConnectionRegistry {
  readonly #entries = new Map<string, RuntimeConnectionEntry>();

  register(entry: RuntimeConnectionEntry): void {
    const previous = this.#entries.get(entry.computerId);
    this.#entries.set(entry.computerId, entry);
    if (previous && previous.socket !== entry.socket) {
      previous.socket.close(4001, "Replaced by a newer daemon instance");
    }
  }

  isCurrent(computerId: string, instanceId: string, socket: WebSocket): boolean {
    const current = this.#entries.get(computerId);
    return current?.instanceId === instanceId && current.socket === socket;
  }

  touch(computerId: string, instanceId: string, socket: WebSocket, now = Date.now()): boolean {
    const current = this.#entries.get(computerId);
    if (!current || current.instanceId !== instanceId || current.socket !== socket) {
      return false;
    }
    current.lastHeartbeatAt = now;
    return true;
  }

  remove(computerId: string, instanceId: string, socket: WebSocket): boolean {
    if (!this.isCurrent(computerId, instanceId, socket)) {
      return false;
    }
    return this.#entries.delete(computerId);
  }

  terminateStale(cutoff: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.lastHeartbeatAt < cutoff) {
        entry.socket.terminate();
      }
    }
  }

  closeAll(): void {
    for (const entry of this.#entries.values()) {
      entry.socket.close(1001, "Server shutting down");
    }
  }
}
