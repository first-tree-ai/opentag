import {
  type ErrorCategory,
  type ImBindingUnbindRequiredDetail,
  ImBindingUnbindRequiredDetailSchema,
} from "@opentag/shared";

export class ImBindingServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly category: ErrorCategory = "deterministic",
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
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
