import { escapeHtmlAttribute, escapeHtmlText } from "../platform/html-escape";
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
export function buildAccountVerificationEmail(url: string): AccountVerificationEmailContent {
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
