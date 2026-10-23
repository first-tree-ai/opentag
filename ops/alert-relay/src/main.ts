import { readConfig } from "./config.ts";
import { FeishuClient } from "./feishu.ts";
import { relayServer } from "./server.ts";

const config = readConfig(process.env);
const feishu = new FeishuClient(config);
const server = relayServer(config, feishu, (severity, event, fields) => {
  console.log(JSON.stringify({ severity, event, ...fields }));
});
server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ severity: "INFO", event: "relay_started", revision: config.revision }));
});
process.on("SIGTERM", () => {
  server.close();
  setTimeout(() => process.exit(0), 12_000).unref();
});
