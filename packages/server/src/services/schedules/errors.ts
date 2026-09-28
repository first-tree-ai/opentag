import {
  SCHEDULE_ERROR_CODE_METADATA,
  SCHEDULE_ERROR_CODES,
  type ScheduleErrorCategory,
  type ScheduleErrorCode,
} from "@opentag/shared";

/**
 * A Schedule management failure with the stable code, category, and HTTP status the shared
 * `SCHEDULE_ERROR_CODE_METADATA` table assigns. The application error handler renders this as the
 * standard envelope, so callers always see the documented code.
 */
export class ScheduleServiceError extends Error {
  readonly code: ScheduleErrorCode;
  readonly category: ScheduleErrorCategory;
  readonly statusCode: number;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = "ScheduleServiceError";
    this.code = code;
    const metadata = SCHEDULE_ERROR_CODE_METADATA[code];
    this.category = metadata.category;
    this.statusCode = metadata.statusCode;
  }
}

export function scheduleError(code: ScheduleErrorCode, message: string): ScheduleServiceError {
  return new ScheduleServiceError(code, message);
}

export function scheduleInvalidRequest(message: string): ScheduleServiceError {
  return new ScheduleServiceError(SCHEDULE_ERROR_CODES.INVALID_REQUEST, message);
}
