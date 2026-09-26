export const CONTACT_EMAIL = "drydock@drydock.org";

export function contactMailto(subject: string, body: string): string {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
