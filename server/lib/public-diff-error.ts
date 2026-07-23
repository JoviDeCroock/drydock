// Shared by the npm and PyPI public-diff loaders; lives in its own module so
// ecosystem-specific loaders can throw it without importing the orchestrating
// public-diff module.
export class PublicDiffError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 413 | 502,
  ) {
    super(message);
    this.name = "PublicDiffError";
  }
}
