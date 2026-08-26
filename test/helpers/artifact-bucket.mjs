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
