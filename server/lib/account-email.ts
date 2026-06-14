import { appDisplayName } from "./brand";
import { sendNotificationEmail, type EmailSendResult } from "./email";

export interface AccountVerificationEmailContent {
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
export function buildAccountVerificationEmail(
  url: string,
  appName = "drydock",
): AccountVerificationEmailContent {
  const safeHref = escapeHtmlAttribute(url);
  const safeText = escapeHtml(url);
  const safeAppName = escapeHtml(appName);
  return {
    subject: `Verify your email for ${appName}`,
    text: [
      `Welcome to ${appName},`,
      "",
      "Confirm your email address to activate your account:",
      url,
      "",
      `This link expires in 24 hours. If you didn't create a ${appName} account, you can ignore this email.`,
      "",
      `-- ${appName}`,
    ].join("\n"),
    html: [
      `<p>Welcome to ${safeAppName},</p>`,
      "<p>Confirm your email address to activate your account:</p>",
      `<p><a href="${safeHref}">Verify email address</a></p>`,
      `<p>Or paste this link into your browser:<br>${safeText}</p>`,
      `<p>This link expires in 24 hours. If you didn't create a ${safeAppName} account, you can ignore this email.</p>`,
      `<p>${escapeHtml(`-- ${appName}`)}</p>`,
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
  const content = buildAccountVerificationEmail(input.url, appDisplayName(env));
  return sendNotificationEmail(env, {
    to: input.email,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
