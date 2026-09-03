import { resolve } from "node:path";
import { redactForLog } from "@opentag/shared";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import {
  CLIENT_LOG_MIN_RETENTION_MS,
  RotatingFileStream,
  writeStringToFileDescriptor,
} from "./rotating-file-stream.js";

export type ClientLogBindings = Readonly<Record<string, unknown>>;

export interface ClientLogger {
  child(bindings: ClientLogBindings): ClientLogger;
  debug(fields: ClientLogBindings, message: string): void;
  error(fields: ClientLogBindings, message: string): void;
  info(fields: ClientLogBindings, message: string): void;
  warn(fields: ClientLogBindings, message: string): void;
}

export interface CreateLoggerOptions {
  destination?: "configured" | "stderr" | "file" | "dual";
}

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
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
let serviceDestination: DestinationStream | undefined;
let rootLogger: PinoLogger | undefined;
let clientLoggerContext: ClientLogBindings = {};

export function configureClientLoggerForService(logDirectory: string): void {
  const canonicalDirectory = resolve(logDirectory);
  if (serviceDirectory && serviceDirectory !== canonicalDirectory) {
    throw new Error("The Client logger is already configured for a different log directory");
  }
  if (serviceDirectory) return;
  serviceDirectory = canonicalDirectory;
  serviceStream = undefined;
  serviceDestination = undefined;
  rootLogger = undefined;
}

export function configureClientLoggerContext(bindings: ClientLogBindings): void {
  clientLoggerContext = { ...clientLoggerContext, ...redactForLog(bindings) };
  rootLogger = undefined;
}

export function createLogger(module: string, options: CreateLoggerOptions = {}): ClientLogger {
  if (options.destination === "stderr") return adapt(fixed(buildRoot(stderrDestination(), false)), { module });
  if (options.destination === "file") return adapt(fixed(buildRoot(fileDestination(), true)), { module });
  if (options.destination === "dual") return adapt(fixed(buildRoot(dualDestination(), true)), { module });
  return adapt(root, { module });
}

export function resetClientLoggerForTests(): void {
  serviceStream?.close();
  serviceDirectory = undefined;
  serviceStream = undefined;
  serviceDestination = undefined;
  rootLogger = undefined;
  clientLoggerContext = {};
}

function root(): PinoLogger {
  if (rootLogger) return rootLogger;
  rootLogger = buildRoot(fileDestination(), serviceDirectory !== undefined);
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
      base: Object.keys(clientLoggerContext).length > 0 ? clientLoggerContext : null,
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

function fileDestination(): DestinationStream {
  if (!serviceDirectory) return stderrDestination();
  if (serviceDestination) return serviceDestination;
  serviceDestination = {
    write(chunk: string) {
      getServiceStream().write(chunk);
    },
  };
  return serviceDestination;
}

function dualDestination(): DestinationStream {
  if (!serviceDirectory) return stderrDestination();
  const file = fileDestination();
  return {
    write(chunk: string) {
      file.write(chunk);
      try {
        writeStringToFileDescriptor(2, chunk);
      } catch {
        // Logging failures never escape into runtime behavior.
      }
    },
  };
}

function getServiceStream(): RotatingFileStream {
  if (!serviceDirectory) throw new Error("The Client logger has no configured service directory");
  serviceStream ??= new RotatingFileStream(serviceDirectory, { minRetentionMs: CLIENT_LOG_MIN_RETENTION_MS });
  return serviceStream;
}

function fixed(logger: PinoLogger): () => PinoLogger {
  return () => logger;
}

function adapt(resolveLogger: () => PinoLogger, bindings: ClientLogBindings): ClientLogger {
  const write = (method: "debug" | "error" | "info" | "warn", fields: ClientLogBindings, message: string) =>
    safeWrite(() => {
      const logger = resolveLogger();
      // Redaction walks and rewrites every string, so it must not run for a line the level discards.
      // Pino would drop the record anyway, but the arguments are evaluated before that call.
      if (!logger.isLevelEnabled(method)) return;
      logger[method](redactForLog({ ...bindings, ...fields }) as ClientLogBindings, redactForLog(message));
    });
  return {
    child: (childBindings) => adapt(resolveLogger, { ...bindings, ...childBindings }),
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
