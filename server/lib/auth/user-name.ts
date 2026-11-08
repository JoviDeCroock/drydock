/**
 * Account display names.
 *
 * `user.name` is free text from sign-up, `update-user`, or a GitHub profile,
 * and it reaches other people: invite emails name the inviter, and a personal
 * workspace is named after its owner. Names are stored as one short plain line
 * so they cannot carry paragraphs of their own into mail Drydock sends.
 */
import {
  hasLineBreakingOrInvisibleCharacters,
  toSingleLineText,
} from "../platform/single-line-text";
import { USER_NAME_MAX_LENGTH } from "../../../src/lib/user-name";

export const INVALID_USER_NAME_MESSAGE = `Name must be one line of at most ${USER_NAME_MAX_LENGTH} characters.`;

export function normalizeUserName(value: string): string {
  return toSingleLineText(value, USER_NAME_MAX_LENGTH);
}

/**
 * Whether a name a person typed should be refused rather than silently
 * rewritten. Extra spaces are only collapsed; anything else normalization would
 * change (line breaks, control or invisible characters, stacked marks, extra
 * length) is refused so the account holder sees why.
 */
export function isAcceptableTypedUserName(value: string): boolean {
  if (hasLineBreakingOrInvisibleCharacters(value)) return false;
  return normalizeUserName(value) === value.trim().replace(/\s+/gu, " ");
}
