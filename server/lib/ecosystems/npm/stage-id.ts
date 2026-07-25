export const STAGE_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9._:-]{5,160}";

const STAGE_ID_RE = new RegExp(`^${STAGE_ID_PATTERN}$`);

export function isValidStageId(value: unknown): value is string {
  return typeof value === "string" && STAGE_ID_RE.test(value);
}
