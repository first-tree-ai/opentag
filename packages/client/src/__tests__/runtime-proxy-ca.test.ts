import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { expect, it } from "vitest";
import { generateExecutionCa } from "../runtime/runtime-proxy-loopback-adapter.js";

it("creates independent P-256 execution certificates trusted by TLS 1.2 and TLS 1.3", async () => {
  const root = await mkdtemp(join(tmpdir(), "opentag-ca-contract-"));
  try {
    const first = await generateExecutionCa(root);
    const certificate = await readFile(first.certPath);
    const key = await readFile(first.keyPath);
    const x509 = new X509Certificate(certificate);
    expect(createPrivateKey(key).asymmetricKeyType).toBe("ec");
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x509.ca).toBe(true);
    expect(x509.verify(x509.publicKey)).toBe(true);
    for (const host of [
      "localhost",
      "github.com",
      "api.github.com",
      "slack.com",
      "open.feishu.cn",
      "open.larksuite.com",
    ]) {
      expect(x509.checkHost(host)).toBe(host);
    }
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(x509.checkHost("foreign.invalid")).toBeUndefined();
    if (process.platform !== "win32") {
      expect((await stat(first.keyPath)).mode & 0o777).toBe(0o600);
      expect((await stat(first.certPath)).mode & 0o777).toBe(0o644);
    }
    const server = createServer({ cert: certificate, key }, (socket) => socket.end("verified"));
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("Missing fixture TLS address");
      for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
        const received = await new Promise<string>((done, reject) => {
          const client = connect({
            host: "127.0.0.1",
            port: address.port,
            servername: "slack.com",
            ca: certificate,
            minVersion: version,
            maxVersion: version,
          });
          let text = "";
          client.on("error", reject);
          client.on("data", (chunk) => {
            text += chunk;
          });
          client.on("end", () => done(text));
        });
        expect(received).toBe("verified");
      }
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
    const replacement = await generateExecutionCa(root);
    const replacementCertificate = new X509Certificate(await readFile(replacement.certPath));
    expect(replacementCertificate.fingerprint256).not.toBe(x509.fingerprint256);
    expect(replacementCertificate.publicKey.equals(x509.publicKey)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
