import { ZodError } from "zod";

export class RequestValidationError extends Error {
  constructor(options?: ErrorOptions) {
    super("The request payload is invalid", options);
    this.name = "RequestValidationError";
  }
}

export function parseRequest<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError({ cause: error });
    }
    throw error;
  }
}
