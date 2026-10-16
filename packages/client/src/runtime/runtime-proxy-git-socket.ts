import net from "node:net";

const MAX_HANDSHAKE_BYTES = 4096;
const CONNECT_REPLY = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

/** Native Git/libcurl supports SOCKS5 over Unix sockets. This is a fixed GitHub HTTP IPC entry,
 * never a general SOCKS proxy: no DNS, TCP dialing, IP destinations, BIND or UDP forwarding. */
export function createGitProxySocketServer(
  accept: (socket: net.Socket, head: Buffer) => void,
  track: (socket: net.Socket) => void,
): net.Server {
  return net.createServer((socket) => {
    track(socket);
    new GitProxyHandshake(socket, accept);
  });
}

class GitProxyHandshake {
  #buffer = Buffer.alloc(0);
  #greeted = false;

  constructor(
    readonly socket: net.Socket,
    readonly accept: (socket: net.Socket, head: Buffer) => void,
  ) {
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", this.#data);
  }

  readonly #data = (chunk: Buffer): void => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_HANDSHAKE_BYTES) {
      this.socket.destroy();
      return;
    }
    if (!this.#greeted && !this.#greet()) return;
    this.#connect();
  };

  #greet(): boolean {
    if (this.#buffer.length < 2) return false;
    const count = this.#buffer[1] as number;
    if (this.#buffer[0] !== 5 || count === 0) {
      this.socket.removeListener("data", this.#data);
      this.socket.end(Buffer.from([5, 255]));
      return false;
    }
    if (this.#buffer.length < 2 + count) return false;
    if (!this.#buffer.subarray(2, 2 + count).includes(0)) {
      this.socket.removeListener("data", this.#data);
      this.socket.end(Buffer.from([5, 255]));
      return false;
    }
    this.#buffer = this.#buffer.subarray(2 + count);
    this.#greeted = true;
    this.socket.write(Buffer.from([5, 0]));
    return true;
  }

  #connect(): void {
    if (this.#buffer.length < 5) return;
    const size = 7 + (this.#buffer[4] as number);
    if (this.#buffer[0] !== 5 || this.#buffer[1] !== 1 || this.#buffer[2] !== 0 || this.#buffer[3] !== 3) {
      this.#reject();
      return;
    }
    if (this.#buffer.length < size) return;
    const host = this.#buffer
      .subarray(5, size - 2)
      .toString("utf8")
      .toLowerCase();
    if (host !== "github.com" || this.#buffer.readUInt16BE(size - 2) !== 80) {
      this.#reject();
      return;
    }
    const head = this.#buffer.subarray(size);
    this.socket.removeListener("data", this.#data);
    this.socket.setTimeout(0);
    this.socket.write(CONNECT_REPLY);
    this.accept(this.socket, head);
  }

  #reject(): void {
    this.socket.removeListener("data", this.#data);
    this.socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
  }
}
