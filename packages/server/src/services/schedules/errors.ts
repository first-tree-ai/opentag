import {
  SCHEDULE_ERROR_CODE_METADATA,
  SCHEDULE_ERROR_CODES,
  type ScheduleErrorCategory,
  type ScheduleErrorCode,
} from "@opentag/shared";
import { DomainServiceError } from "../domain-service-error.js";

/**
 * A Schedule management failure with the stable code, category, and HTTP status the shared
 * `SCHEDULE_ERROR_CODE_METADATA` table assigns. The application error handler renders this as the
 * standard envelope, so callers always see the documented code.
 */
export class ScheduleServiceError extends DomainServiceError<ScheduleErrorCode, ScheduleErrorCategory, number> {
  constructor(code: ScheduleErrorCode, message: string) {
    const metadata = SCHEDULE_ERROR_CODE_METADATA[code];
    super({ code, category: metadata.category, statusCode: metadata.statusCode, message });
    this.name = "ScheduleServiceError";
  }
}

export function scheduleError(code: ScheduleErrorCode, message: string): ScheduleServiceError {
  return new ScheduleServiceError(code, message);
}

export function scheduleInvalidRequest(message: string): ScheduleServiceError {
  return new ScheduleServiceError(SCHEDULE_ERROR_CODES.INVALID_REQUEST, message);
}
