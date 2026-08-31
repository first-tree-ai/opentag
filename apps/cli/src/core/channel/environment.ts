import { channelConfig } from "./config.js";
import { markChannelDefaultHomeApplied } from "./home-source.js";

/** Return the command environment with the channel home selected, without mutating process.env. */
export function resolveChannelEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (!result.OPENTAG_HOME) {
    result.OPENTAG_HOME = channelConfig.defaultHome;
    markChannelDefaultHomeApplied();
  }
  return result;
}
