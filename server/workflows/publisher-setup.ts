import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { PublisherSetupRetryError, runPublisherSetupDraftJob } from "../lib/github-app/setup-jobs";

export class PublisherSetupWorkflow extends WorkflowEntrypoint<Cloudflare.Env, { jobId: string }> {
  async run(
    event: Readonly<WorkflowEvent<{ jobId: string }>>,
    step: WorkflowStep,
  ): Promise<{ jobId: string }> {
    try {
      await runPublisherSetupDraftJob(
        this.env,
        event.payload.jobId,
        async (stage, operation, retrySafeOperation) => {
          await step.do(
            stage,
            {
              retries: {
                limit: retrySafeOperation ? 1 : 0,
                delay: "5 seconds",
                backoff: "constant",
              },
              timeout: "4 minutes",
            },
            async () => {
              try {
                await operation();
              } catch (error) {
                if (error instanceof PublisherSetupRetryError) throw new Error(error.failureCode);
                throw new NonRetryableError("setup_workflow_failed");
              }
              return { jobId: event.payload.jobId };
            },
          );
        },
      );
      return { jobId: event.payload.jobId };
    } catch {
      throw new NonRetryableError("setup_workflow_failed");
    }
  }
}
