export type ClassValue = string | number | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out = out ? `${out} ${part}` : String(part);
  }
  return out;
}
