/**
 * In-memory stand-in for the `ARTIFACTS` R2 bucket.
 *
 * A completed scan's body lives only in R2, so any test that drives the
 * pipeline through `persistResults` has to bind a bucket — the write fails
 * closed without one. Only `put`/`get`/`delete`/`list` are implemented, which is
 * all the artifact reader and writer use.
 */
export function createMemoryArtifactBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      return {};
    },
    async get(key) {
      const body = objects.get(key);
      if (body === undefined) return null;
      return {
        async arrayBuffer() {
          return new TextEncoder().encode(body).buffer;
        },
        async text() {
          return body;
        },
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
}
