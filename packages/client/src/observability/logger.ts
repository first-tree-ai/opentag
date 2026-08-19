import { resolve } from "node:path";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import { RotatingFileStream, writeStringToFileDescriptor } from "./rotating-file-stream.js";

export type ClientLogBindings = Readonly<Record<string, unknown>>;

export interface ClientLogger {
  child(bindings: ClientLogBindings): ClientLogger;
  debug(fields: ClientLogBindings, message: string): void;
  error(fields: ClientLogBindings, message: string): void;
  info(fields: ClientLogBindings, message: string): void;
  warn(fields: ClientLogBindings, message: string): void;
}

interface CreateLoggerOptions {
  destination?: "configured" | "stderr";
}

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
const SENSITIVE_KEYS = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "jwt",
  "secret",
  "apiKey",
  "api_key",
  "credentials",
  "authorization",
] as const;
const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  "headers.authorization",
  "headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
];

let serviceDirectory: string | undefined;
let serviceStream: RotatingFileStream | undefined;
let rootLogger: PinoLogger | undefined;

export function configureClientLoggerForService(logDirectory: string): void {
  const canonicalDirectory = resolve(logDirectory);
  if (serviceDirectory && serviceDirectory !== canonicalDirectory) {
    throw new Error("The Client logger is already configured for a different log directory");
  }
  if (serviceDirectory) return;
  serviceDirectory = canonicalDirectory;
  serviceStream = new RotatingFileStream(canonicalDirectory);
  rootLogger = undefined;
}

export function createLogger(module: string, options: CreateLoggerOptions = {}): ClientLogger {
  return adapt(options.destination === "stderr" ? buildRoot(stderrDestination(), false) : root(), { module });
}

export function resetClientLoggerForTests(): void {
  serviceStream?.close();
  serviceDirectory = undefined;
  serviceStream = undefined;
  rootLogger = undefined;
}

function root(): PinoLogger {
  if (rootLogger) return rootLogger;
  rootLogger = buildRoot(serviceStream ?? stderrDestination(), serviceDirectory !== undefined);
  return rootLogger;
}

function buildRoot(destination: DestinationStream, serviceMode: boolean): PinoLogger {
  const configured = process.env.OPENTAG_LOG_LEVEL;
  const validConfigured = configured && LOG_LEVELS.has(configured) ? configured : undefined;
  const level =
    validConfigured ??
    (configured ? "info" : process.env.NODE_ENV === "test" ? "silent" : serviceMode ? "info" : "warn");
  const logger = pino(
    {
      base: null,
      level,
      messageKey: "message",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
  if (configured && !validConfigured) {
    logger.warn({ module: "logger" }, "Invalid OPENTAG_LOG_LEVEL; using info");
  }
  return logger;
}

function stderrDestination(): DestinationStream {
  return {
    write(chunk: string) {
      try {
        writeStringToFileDescriptor(2, chunk);
      } catch {
        // Logging failures never escape into runtime behavior.
      }
    },
  };
}

function adapt(logger: PinoLogger, bindings: ClientLogBindings): ClientLogger {
  const write = (method: "debug" | "error" | "info" | "warn", fields: ClientLogBindings, message: string) =>
    safeWrite(() => logger[method]({ ...bindings, ...fields }, message));
  return {
    child: (childBindings) => adapt(logger, { ...bindings, ...childBindings }),
    debug: (fields, message) => write("debug", fields, message),
    error: (fields, message) => write("error", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
  };
}

function safeWrite(write: () => void): void {
  try {
    write();
  } catch {
    // Observability is deliberately isolated from business behavior.
  }
}
