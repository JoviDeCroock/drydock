export function githubAppHeaders(jwt: string) {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function githubInstallationHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function githubUserHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "drydock-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function nextLink(linkHeader: string | null): string {
  if (!linkHeader) return "";
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return "";
}
