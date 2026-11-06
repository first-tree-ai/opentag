import type { ErrorCategory } from "@opentag/shared";

export interface DomainServiceErrorInit<
  TCode extends string = string,
  TCategory extends ErrorCategory = ErrorCategory,
  TStatusCode extends number = number,
> {
  code: TCode;
  category: TCategory;
  statusCode: TStatusCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

/**
 * Base class for Account-facing domain service errors.
 *
 * Carries the structured error contract (`code`, `category`, `statusCode`, `message`, and optional
 * bounded `details`) so the HTTP error handler can classify and serialize any domain failure via a
 * single `instanceof DomainServiceError` check while preserving subclass `instanceof` identity.
 */
export class DomainServiceError<
  TCode extends string = string,
  TCategory extends ErrorCategory = ErrorCategory,
  TStatusCode extends number = number,
> extends Error {
  readonly code: TCode;
  readonly category: TCategory;
  readonly statusCode: TStatusCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(init: DomainServiceErrorInit<TCode, TCategory, TStatusCode>) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.category = init.category;
    this.statusCode = init.statusCode;
    this.details = init.details;
  }
}
