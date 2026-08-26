/** Whether an HTTP(S) URL is acceptable in a generated POSIX shell command. */
export function isSafeHttpUrlForShellArgument(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** Quote one opaque value for use as a single argument in a POSIX shell command. */
export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
