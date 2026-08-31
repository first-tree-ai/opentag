import { registerApp } from "@larksuiteoapi/node-sdk";
import { DefaultFeishuRegistrationGateway } from "./src/services/im-bindings/feishu/registration.js";

const brand = (process.argv[2] ?? "lark") as "feishu" | "lark";
const observed = ((options: Parameters<typeof registerApp>[0]) => {
  console.log(`[options] brand=${brand} domain=${options.domain ?? "(sdk default)"} source=${options.source}`);
  return registerApp({ ...options, onStatusChange: (info) => console.log(`[status] ${JSON.stringify(info)}`) });
}) as typeof registerApp;

const registration = new DefaultFeishuRegistrationGateway(observed).start({
  profile: { name: "OpenTag Lark Probe", description: "OpenTag Agent: OpenTag Lark Probe" },
  intent: "create",
  receiveMode: "all_message",
  brand,
});
registration.qrReady.then(
  (qr) => console.log(`[qr] ${qr.url}\n[qr] expiresAt=${qr.expiresAt.toISOString()}`),
  (cause) => console.log(`[qr-failed] ${String(cause)}`),
);
registration.result.then(
  (r) =>
    console.log(`[result] appId=${r.appId} tenant_brand=${String(r.teamBrand)} secretLength=${r.appSecret.length}`),
  (cause) => console.log(`[result-failed] ${String((cause as { code?: string })?.code)} ${String(cause)}`),
);
