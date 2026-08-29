import { channelConfig } from "./config.js";
import { markChannelDefaultHomeApplied } from "./home-source.js";

if (!process.env.OPENTAG_HOME) {
  process.env.OPENTAG_HOME = channelConfig.defaultHome;
  markChannelDefaultHomeApplied();
}
