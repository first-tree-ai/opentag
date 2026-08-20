import { createAgentsApi } from "./api/agents.js";
import { createAuthApi } from "./api/auth.js";
import { createComputersApi } from "./api/computers.js";
import { createSystemApi } from "./api/system.js";
import { createTeamsApi } from "./api/teams.js";
import { BrowserTransport } from "./api/transport.js";

export { ApiError } from "./api/transport.js";

export class BrowserApi {
  readonly auth;
  readonly agents;
  readonly computers;
  readonly system;
  readonly teams;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    const transport = new BrowserTransport(fetchImpl);
    this.auth = createAuthApi(transport);
    this.agents = createAgentsApi(transport);
    this.computers = createComputersApi(transport);
    this.system = createSystemApi(fetchImpl);
    this.teams = createTeamsApi(transport);
  }
}

export const browserApi = new BrowserApi();
