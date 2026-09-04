import { channelConfig } from "./config.js";
import { markChannelDefaultHomeApplied } from "./home-source.js";

/**
 * The environment variable the daemon service definitions and channel tooling use to name the
 * OpenTag home. It is the same one every channel's service template embeds; do not hard-code a
 * second spelling in repair commands that must reach a custom `--home`.
 */
export const OPEN_TAG_HOME_ENVIRONMENT_VARIABLE = "OPENTAG_HOME";

/** Return the command environment with the channel home selected, without mutating process.env. */
export function resolveChannelEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (!result[OPEN_TAG_HOME_ENVIRONMENT_VARIABLE]) {
    result[OPEN_TAG_HOME_ENVIRONMENT_VARIABLE] = channelConfig.defaultHome;
    markChannelDefaultHomeApplied();
  }
  return result;
}
