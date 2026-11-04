import dns from "node:dns";

const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  if (hostname !== "held-listen.test") return Reflect.apply(lookup, this, [hostname, ...args]);
  process.send?.({ stage: "listen-dns" });
  process.once("message", () => {
    process.disconnect?.();
    Reflect.apply(lookup, dns, ["127.0.0.1", ...args]);
  });
};
