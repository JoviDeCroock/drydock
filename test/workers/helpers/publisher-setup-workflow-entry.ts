import { PublisherSetupWorkflow as ProductionPublisherSetupWorkflow } from "../../../server/workflows/publisher-setup";
export { default, NpmStageGateway } from "../../../server";

let overrides: Partial<Cloudflare.Env> = {};
export function configurePublisherSetupWorkflowTest(env: Partial<Cloudflare.Env>): void {
  overrides = env;
}

// Tests supply inert model/config bindings to the production entrypoint while
// the local Cloudflare Workflows engine still owns checkpointing and retries.
export class PublisherSetupWorkflow extends ProductionPublisherSetupWorkflow {
  constructor(ctx: ExecutionContext, env: Cloudflare.Env) {
    super(ctx, { ...env, ...overrides });
  }
}
