import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const CLIENT_LOG_FILE_NAME = "client.log";
export const CLIENT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const CLIENT_LOG_BACKUPS = 7;

export interface RotatingFileStreamOptions {
  fallbackWrite?: (chunk: string) => void;
  operations?: Partial<RotatingFileOperations>;
  maxBackups?: number;
  maxBytes?: number;
}

export interface RotatingFileOperations {
  close(fileDescriptor: number): void;
  fileStatus(fileDescriptor: number): Stats;
  fchmod(fileDescriptor: number, mode: number): void;
  lstat(path: string): Stats;
  makeDirectory(path: string, mode: number): void;
  open(path: string, flags: number, mode: number): number;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  write(fileDescriptor: number, buffer: Buffer, offset: number, length: number): number;
}

const defaultOperations: RotatingFileOperations = {
  close: closeSync,
  fileStatus: fstatSync,
  fchmod: fchmodSync,
  lstat: lstatSync,
  makeDirectory: (path, mode) => mkdirSync(path, { recursive: true, mode }),
  open: openSync,
  rename: renameSync,
  unlink: unlinkSync,
  write: (fileDescriptor, buffer, offset, length) => writeSync(fileDescriptor, buffer, offset, length),
};

export class RotatingFileStream {
  readonly directory: string;
  readonly path: string;
  readonly #fallbackWrite: (chunk: string) => void;
  readonly #maxBackups: number;
  readonly #maxBytes: number;
  readonly #operations: RotatingFileOperations;
  #bytes = 0;
  #failed = false;
  #fileDescriptor?: number;

  constructor(directory: string, options: RotatingFileStreamOptions = {}) {
    this.directory = resolve(directory);
    this.path = join(this.directory, CLIENT_LOG_FILE_NAME);
    this.#fallbackWrite = options.fallbackWrite ?? ((chunk) => writeStringToFileDescriptor(2, chunk));
    this.#operations = { ...defaultOperations, ...options.operations };
    this.#maxBackups = options.maxBackups ?? CLIENT_LOG_BACKUPS;
    this.#maxBytes = options.maxBytes ?? CLIENT_LOG_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBackups) || this.#maxBackups < 1) {
      throw new Error("Client log backup count must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1) {
      throw new Error("Client log size limit must be a positive safe integer");
    }
    this.#open();
  }

  write(chunk: string): boolean {
    if (this.#failed) return this.#writeFallback(chunk);
    try {
      const bytes = Buffer.from(chunk, "utf8");
      if (this.#bytes > 0 && this.#bytes + bytes.byteLength > this.#maxBytes) this.#rotate();
      if (this.#fileDescriptor === undefined) throw new Error("Client log file is unavailable");
      this.#writeFully(this.#fileDescriptor, bytes);
      this.#bytes += bytes.byteLength;
    } catch {
      this.#failover();
      this.#writeFallback(chunk);
    }
    return true;
  }

  close(): void {
    if (this.#fileDescriptor === undefined) return;
    try {
      this.#operations.close(this.#fileDescriptor);
    } catch {
      // Logging cleanup must never affect runtime shutdown.
    }
    this.#fileDescriptor = undefined;
  }

  #open(): void {
    try {
      this.#ensurePrivateDirectory();
      this.#openLogFile();
    } catch {
      this.#failover();
    }
  }

  #rotate(): void {
    this.close();
    this.#removeIfPresent(`${this.path}.${this.#maxBackups}`);
    for (let index = this.#maxBackups - 1; index >= 1; index -= 1) {
      this.#renameIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    this.#renameIfPresent(this.path, `${this.path}.1`);
    this.#openLogFile();
  }

  #ensurePrivateDirectory(): void {
    this.#operations.makeDirectory(this.directory, 0o700);
    const pathStatus = this.#operations.lstat(this.directory);
    if (!pathStatus.isDirectory() || pathStatus.isSymbolicLink()) {
      throw new Error("Client log directory must be a real directory");
    }
    const fileDescriptor = this.#operations.open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      0o700,
    );
    try {
      const openedStatus = this.#operations.fileStatus(fileDescriptor);
      if (!openedStatus.isDirectory()) throw new Error("Client log directory changed during open");
      this.#operations.fchmod(fileDescriptor, 0o700);
    } finally {
      this.#operations.close(fileDescriptor);
    }
  }

  #openLogFile(): void {
    try {
      const pathStatus = this.#operations.lstat(this.path);
      if (!pathStatus.isFile() || pathStatus.isSymbolicLink()) {
        throw new Error("Client log path must be a regular file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const fileDescriptor = this.#operations.open(
      this.path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const openedStatus = this.#operations.fileStatus(fileDescriptor);
      if (!openedStatus.isFile()) throw new Error("Client log path changed during open");
      this.#operations.fchmod(fileDescriptor, 0o600);
      this.#fileDescriptor = fileDescriptor;
      this.#bytes = openedStatus.size;
    } catch (error) {
      this.#operations.close(fileDescriptor);
      throw error;
    }
  }

  #renameIfPresent(from: string, to: string): void {
    try {
      this.#operations.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #removeIfPresent(path: string): void {
    try {
      this.#operations.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #failover(): void {
    this.close();
    this.#failed = true;
  }

  #writeFallback(chunk: string): boolean {
    try {
      this.#fallbackWrite(chunk);
    } catch {
      // A broken diagnostic destination must remain isolated from the runtime.
    }
    return true;
  }

  #writeFully(fileDescriptor: number, buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.byteLength) {
      const written = this.#operations.write(fileDescriptor, buffer, offset, buffer.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.byteLength - offset) {
        throw new Error("Client log write returned an invalid byte count");
      }
      offset += written;
    }
  }
}

export function writeStringToFileDescriptor(fileDescriptor: number, chunk: string): void {
  const buffer = Buffer.from(chunk, "utf8");
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(fileDescriptor, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.byteLength - offset) {
      throw new Error("Diagnostic write returned an invalid byte count");
    }
    offset += written;
  }
}
