import type { RuntimeConnection } from "./runtime-connection.js";

export class ClientRuntime {
  constructor(readonly connection: RuntimeConnection) {}

  run(): Promise<void> {
    return this.connection.run();
  }

  stop(): void {
    this.connection.stop();
  }
}
