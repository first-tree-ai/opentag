/**
 * Base error raised when an in-memory bounded runtime store or registry reaches its capacity limit.
 */
export class RuntimeStoreCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
