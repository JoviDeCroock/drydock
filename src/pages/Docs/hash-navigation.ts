type ScrollTarget = {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
};

type HashTargetRoot = {
  getElementById(id: string): ScrollTarget | null;
};

export function docsHashTargetId(hash: string): string | null {
  if (!hash.startsWith("#") || hash.length === 1) return null;

  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export function scrollToDocsHash(hash: string, root: HashTargetRoot): boolean {
  const id = docsHashTargetId(hash);
  if (!id) return false;

  const target = root.getElementById(id);
  if (!target) return false;

  target.scrollIntoView({ block: "start" });
  return true;
}
