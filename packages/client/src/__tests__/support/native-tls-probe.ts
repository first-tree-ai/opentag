import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "vitest";

const exec = promisify(execFile);
const baselines = new Map<string, string | undefined>();

/** Probe a valid private anchor without any OpenTag adapter, Git config, helper or proxy. */
async function probe(root: string, backend: string | undefined): Promise<string | undefined> {
  const directory = await mkdtemp(join(root, "tls-baseline-"));
  const key = join(directory, "key.pem"),
    cert = join(directory, "cert.pem");
  let server: https.Server | undefined;
  try {
    await exec(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        "/CN=Native TLS baseline",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { timeout: 30000 },
    );
    server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
      response.end("baseline");
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      await exec(
        "curl",
        ["--fail", "--silent", "--show-error", "--max-time", "5", "--cacert", cert, `https://127.0.0.1:${port}/`],
        {
          env: { HOME: root, PATH: process.env.PATH, CURL_SSL_BACKEND: backend },
          timeout: 10000,
        },
      );
    } catch (error) {
      const failure = error as { code?: number; stderr?: string };
      if (failure.code !== 60) throw error;
      return `macOS native curl (${backend ?? "default TLS backend"}) rejects a valid private --cacert anchor (exit 60); HTTPS/CONNECT capability unavailable independently of OpenTag`;
    }
    return undefined;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

export async function skipUnsupportedNativeTls(context: TestContext, root: string, backend?: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const key = backend ?? "default";
  if (!baselines.has(key)) baselines.set(key, await probe(root, backend));
  const reason = baselines.get(key);
  if (reason) {
    console.warn(`[native TLS baseline] ${reason}`);
    context.skip(reason);
  }
}
