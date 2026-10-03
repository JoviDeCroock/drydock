import { escapeHtmlAttribute, escapeHtmlText } from "../platform/html-escape";
import { sendNotificationEmail, type EmailSendResult } from "./email";

export interface AccountEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Compose the account verification email. The only dynamic input is `url`, the
 * Better Auth verification link (same-origin, carries a single-use token). It is
 * HTML-attribute-escaped before being placed in the `href` so a malformed link
 * can never break out of the attribute. The token only ever travels inside the
 * link — never log this body.
 */
export function buildAccountVerificationEmail(url: string): AccountEmailContent {
  const safeHref = escapeHtmlAttribute(url);
  const safeText = escapeHtmlText(url);
  return {
    subject: "Verify your email for Drydock",
    text: [
      "Welcome to Drydock,",
      "",
      "Confirm your email address to activate your account:",
      url,
      "",
      "This link expires in 24 hours. If you didn't create a Drydock account, you can ignore this email.",
      "",
      "— Drydock",
    ].join("\n"),
    html: [
      "<p>Welcome to Drydock,</p>",
      "<p>Confirm your email address to activate your account:</p>",
      `<p><a href="${safeHref}">Verify email address</a></p>`,
      `<p>Or paste this link into your browser:<br>${safeText}</p>`,
      "<p>This link expires in 24 hours. If you didn't create a Drydock account, you can ignore this email.</p>",
      "<p>— Drydock</p>",
    ].join("\n"),
  };
}

export interface AccountVerificationEmailInput {
  email: string;
  url: string;
}

export async function sendAccountVerificationEmail(
  env: Cloudflare.Env,
  input: AccountVerificationEmailInput,
): Promise<EmailSendResult> {
  const content = buildAccountVerificationEmail(input.url);
  return sendNotificationEmail(env, {
    to: input.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}

/**
 * Compose the password-reset email. It is also the "set a password" email for
 * an account that only signs in with GitHub, so the copy fits both. The link
 * carries a single-use token that mints a password: it is escaped like the
 * verification link, and this body must never be logged.
 */
export function buildPasswordResetEmail(
  url: string,
  expiresInMinutes: number,
): AccountEmailContent {
  const safeHref = escapeHtmlAttribute(url);
  const safeText = escapeHtmlText(url);
  const expiry = `This link expires in ${expiresInMinutes} minutes and works once. Setting a password signs the account out on every device.`;
  const ignore =
    "If you didn't ask for this, you can ignore this email. Nothing changes until the link is used.";
  const intro =
    "Someone asked to set a new password for the Drydock account that uses this email address. Choose one here:";
  return {
    subject: "Set your Drydock password",
    text: ["Hello,", "", intro, url, "", expiry, "", ignore, "", "— Drydock"].join("\n"),
    html: [
      "<p>Hello,</p>",
      `<p>${intro}</p>`,
      `<p><a href="${safeHref}">Set a new password</a></p>`,
      `<p>Or paste this link into your browser:<br>${safeText}</p>`,
      `<p>${expiry}</p>`,
      `<p>${ignore}</p>`,
      "<p>— Drydock</p>",
    ].join("\n"),
  };
}

export interface PasswordResetEmailInput {
  email: string;
  url: string;
  expiresInMinutes: number;
}

export async function sendPasswordResetEmail(
  env: Cloudflare.Env,
  input: PasswordResetEmailInput,
): Promise<EmailSendResult> {
  const content = buildPasswordResetEmail(input.url, input.expiresInMinutes);
  return sendNotificationEmail(env, {
    to: input.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}
