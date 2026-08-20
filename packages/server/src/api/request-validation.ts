import type { ValidationIssue } from "@opentag/shared";
import { ZodError } from "zod";

export class RequestValidationError extends Error {
  readonly issues: readonly Readonly<ValidationIssue>[];

  constructor(error: ZodError) {
    super("The request payload is invalid");
    this.name = "RequestValidationError";
    this.issues = Object.freeze(
      error.issues.map((issue) =>
        Object.freeze({
          path: Object.freeze(
            issue.path.filter(
              (segment): segment is string | number => typeof segment === "string" || typeof segment === "number",
            ),
          ) as ValidationIssue["path"],
          code: issue.code,
          message: issue.message,
        }),
      ),
    );
  }
}

export function parseRequest<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError(error);
    }
    throw error;
  }
}
