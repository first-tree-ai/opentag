import { channelConfig } from "./config.js";

if (!process.env.OPENTAG_HOME) {
  process.env.OPENTAG_HOME = channelConfig.defaultHome;
}
