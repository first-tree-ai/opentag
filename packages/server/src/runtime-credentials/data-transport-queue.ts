/** Internal bounded byte queue for one stream's request body; consumed by the adapter. */
export const QUEUE_END = Symbol("queue-end");

export class AsyncByteQueue {
  #chunks: Uint8Array[] = [];
  #waiting?: (chunk: Uint8Array | typeof QUEUE_END) => void;
  #ended = false;

  push(chunk: Uint8Array): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting(chunk);
      return;
    }
    this.#chunks.push(chunk);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting(QUEUE_END);
    }
  }

  take(): Promise<Uint8Array | typeof QUEUE_END> {
    const chunk = this.#chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.#ended) return Promise.resolve(QUEUE_END);
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }
}
