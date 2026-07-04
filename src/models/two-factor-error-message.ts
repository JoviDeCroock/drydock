import { ApiError, errorMessage } from "./api";

export interface TwoFactorErrorCopy {
  enrollmentRequired: string;
  required: string;
  invalid: string;
}

export function twoFactorErrorMessage(err: unknown, copy: TwoFactorErrorCopy): string {
  if (err instanceof ApiError) {
    if (err.code === "two_factor_enrollment_required") {
      return copy.enrollmentRequired;
    }
    if (err.code === "two_factor_required") {
      return copy.required;
    }
    if (err.code === "two_factor_invalid") {
      return copy.invalid;
    }
  }
  return errorMessage(err);
}
