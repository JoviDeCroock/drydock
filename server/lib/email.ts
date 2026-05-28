import { errorMessage } from "./errors";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailBinding {
  send(message: unknown): Promise<void>;
}

export interface EmailSendResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_FROM_ADDRESS = "drydock@resynapse.dev";
const DEFAULT_FROM_NAME = "Drydock";

export async function sendNotificationEmail(
  env: Cloudflare.Env,
  input: SendEmailInput,
): Promise<EmailSendResult> {
  const binding = env.SEND_EMAIL as SendEmailBinding | undefined;
  if (!binding) return { ok: false, reason: "SEND_EMAIL binding is not configured" };

  const recipient = sanitizeAddress(input.to);
  if (!recipient) return { ok: false, reason: "invalid recipient" };

  const fromAddress = sanitizeAddress(env.EMAIL_FROM_ADDRESS) ?? DEFAULT_FROM_ADDRESS;
  const fromName = (env.EMAIL_FROM_NAME ?? DEFAULT_FROM_NAME).replace(/[\r\n]/g, "").slice(0, 80);

  try {
    const { EmailMessage } = (await import("cloudflare:email")) as {
      EmailMessage: new (from: string, to: string, raw: string) => unknown;
    };
    const raw = buildMimeMessage({
      fromAddress,
      fromName,
      to: recipient,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    await binding.send(new EmailMessage(fromAddress, recipient, raw));
    return { ok: true };
  } catch (err) {
    const reason = errorMessage(err);
    return { ok: false, reason };
  }
}

interface BuildMimeMessageInput {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function buildMimeMessage(input: BuildMimeMessageInput): string {
  const boundary = `=_drydock_${randomBoundary()}`;
  const headers: string[] = [
    `From: ${formatAddress(input.fromName, input.fromAddress)}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${input.fromAddress.split("@")[1] ?? "resynapse.dev"}>`,
    "MIME-Version: 1.0",
  ];

  if (input.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      `--${boundary}--`,
      "",
    ];
    return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
  }

  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push("Content-Transfer-Encoding: 8bit");
  return headers.join("\r\n") + "\r\n\r\n" + input.text + "\r\n";
}

export function sanitizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return null;
  if (/[\r\n<>]/.test(trimmed)) return null;
  const match = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  return match ? trimmed : null;
}

function formatAddress(name: string, address: string) {
  if (!name) return address;
  const escaped = name.replace(/[\\"]/g, "\\$&");
  return `"${escaped}" <${address}>`;
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const base64 = btoa(unescape(encodeURIComponent(value)));
  return `=?UTF-8?B?${base64}?=`;
}

function randomBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
