import { channelConfig } from "./channel.js";

if (!process.env.OPENTAG_HOME) {
  process.env.OPENTAG_HOME = channelConfig.defaultHome;
}
