import {
  type ErrorCategory,
  type ImBindingUnbindRequiredDetail,
  ImBindingUnbindRequiredDetailSchema,
} from "@opentag/shared";
import { DomainServiceError } from "../domain-service-error.js";

export class ImBindingServiceError extends DomainServiceError<string, ErrorCategory, number> {
  constructor(
    code: string,
    statusCode: number,
    message: string,
    category: ErrorCategory = "deterministic",
    options: { cause?: unknown } = {},
  ) {
    super({ code, category, message, statusCode, cause: options.cause });
    this.name = "ImBindingServiceError";
  }
}

/** Compatibility envelope for a rejected Provider change; the configured identity stays fixed. */
export class ImBindingUnbindRequiredError extends ImBindingServiceError {
  readonly unbindRequired: ImBindingUnbindRequiredDetail;
  constructor(detail: ImBindingUnbindRequiredDetail) {
    super(
      "IM_BINDING_UNBIND_REQUIRED",
      409,
      "The Agent already has a messaging Provider. Create a new Agent to use another.",
    );
    this.name = "ImBindingUnbindRequiredError";
    this.unbindRequired = ImBindingUnbindRequiredDetailSchema.parse(detail);
  }
}
