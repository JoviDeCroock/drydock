import { bindingDispatcher, type DetonationDispatcher } from "./detonation";

// Bridges the `DETONATION` Durable Object namespace (a Cloudflare Container) to
// the plain `DetonationDispatcher` the route + tests use. Kept out of
// `detonation.ts` so that module — the validation and mapping logic — stays free
// of the container SDK and trivially unit-testable.
//
// `@cloudflare/containers` is imported lazily (like the AI reviewer's lazy
// `import("./ai-review")`): its `Container` base extends `DurableObject` at
// module-eval time, which only exists in the Workers runtime. Loading it eagerly
// would break the node test project, whose `cloudflare:workers` mock has no
// `DurableObject`. Detonation is default-off, so most requests never load it.
export function containerDispatcher(namespace: DurableObjectNamespace): DetonationDispatcher {
  return {
    async detonate(input) {
      const { getContainer } = await import("@cloudflare/containers");
      // Never reuse a container across packages or organizations. Lifecycle
      // scripts may daemonize descendants, so only destroying the whole instance
      // reliably clears processes and its filesystem after a detonation.
      const stub = getContainer(
        namespace as never,
        `detonation-${crypto.randomUUID()}`,
      ) as unknown as Fetcher & { destroy(): Promise<void> };
      try {
        return await bindingDispatcher(stub).detonate(input);
      } finally {
        await stub.destroy();
      }
    },
  };
}
