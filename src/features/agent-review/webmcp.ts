import { z } from "zod";
import {
  publicReviewErrorResult,
  publicReviewFileInput,
  publicReviewInstructions,
  publicReviewPairInput,
  publicReviewSuccessResult,
  publicReviewTools,
} from "../../lib/public-review-tools";
import { ApiError } from "../../models/api";

type PublicReviewWebMcpResult =
  | ReturnType<typeof publicReviewSuccessResult>
  | ReturnType<typeof publicReviewErrorResult>;

interface PublicReviewWebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: false;
    untrustedContentHint: true;
    consequentialHint: false;
  };
  execute(input: unknown, options: { signal: AbortSignal }): Promise<PublicReviewWebMcpResult>;
}

export interface PublicReviewWebMcpContext {
  registerTool(tool: PublicReviewWebMcpTool, options: { signal: AbortSignal }): Promise<void>;
}

export interface PublicReviewWebMcpActions {
  compare(
    input: z.infer<typeof publicReviewPairInput>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
  file(
    input: z.infer<typeof publicReviewFileInput>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export function registerPublicReviewWebMcp(
  context: PublicReviewWebMcpContext | null | undefined,
  actions: PublicReviewWebMcpActions,
): () => void {
  if (!context) return () => {};
  const registration = new AbortController();
  let activeExecution: AbortController | undefined;

  function tool<S extends typeof publicReviewPairInput | typeof publicReviewFileInput>(
    descriptor: {
      name: string;
      title: string;
      description: string;
      inputSchema: S;
    },
    action: (input: z.infer<S>, signal: AbortSignal) => Promise<Record<string, unknown>>,
    pageEffect: string,
  ): PublicReviewWebMcpTool {
    return {
      name: descriptor.name,
      title: descriptor.title,
      description: `${descriptor.description} ${pageEffect} ${publicReviewInstructions}`,
      inputSchema: z.toJSONSchema(descriptor.inputSchema),
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true,
        consequentialHint: false,
      },
      async execute(input, options) {
        if (registration.signal.aborted) {
          return publicReviewErrorResult(
            409,
            undefined,
            "This page's review tools are no longer active.",
          );
        }
        if (options.signal.aborted) {
          return publicReviewErrorResult(
            499,
            undefined,
            "The package review request was cancelled.",
          );
        }
        const parsed = descriptor.inputSchema.safeParse(input);
        if (!parsed.success) {
          return publicReviewErrorResult(
            400,
            undefined,
            "Invalid public package review arguments.",
          );
        }
        activeExecution?.abort();
        const execution = new AbortController();
        activeExecution = execution;
        const signal = AbortSignal.any([registration.signal, options.signal, execution.signal]);
        const cancelledResult = () => {
          if (registration.signal.aborted) {
            return publicReviewErrorResult(
              409,
              undefined,
              "This page's review tools are no longer active.",
            );
          }
          if (options.signal.aborted) {
            return publicReviewErrorResult(
              499,
              undefined,
              "The package review request was cancelled.",
            );
          }
          return publicReviewErrorResult(
            409,
            undefined,
            "A newer review request superseded this request.",
          );
        };
        let cancel: (() => void) | undefined;
        try {
          if (signal.aborted) return cancelledResult();
          const cancelled = new Promise<never>((_, reject) => {
            cancel = () => reject(new DOMException("Cancelled", "AbortError"));
            signal.addEventListener("abort", cancel, { once: true });
          });
          const payload = await Promise.race([
            action(parsed.data as z.infer<S>, signal),
            cancelled,
          ]);
          return signal.aborted ? cancelledResult() : publicReviewSuccessResult(payload);
        } catch (error) {
          if (signal.aborted) return cancelledResult();
          if (error instanceof ApiError) {
            const retry =
              "retryAfterSeconds" in error && typeof error.retryAfterSeconds === "number"
                ? error.retryAfterSeconds
                : undefined;
            const retryAfterSeconds =
              retry !== undefined && Number.isSafeInteger(retry) && retry >= 0 ? retry : undefined;
            return publicReviewErrorResult(
              error.status,
              retryAfterSeconds,
              error.status >= 500 ? undefined : error.message.slice(0, 500),
            );
          }
          return publicReviewErrorResult(502);
        } finally {
          if (cancel) signal.removeEventListener("abort", cancel);
          if (activeExecution === execution) activeExecution = undefined;
        }
      },
    };
  }

  const tools = [
    tool(
      publicReviewTools.compare,
      actions.compare.bind(actions),
      "Updates the visible page to this comparison.",
    ),
    tool(
      publicReviewTools.file,
      actions.file.bind(actions),
      "Updates the visible comparison and selected file.",
    ),
  ];
  void Promise.all(
    tools.map(async (definition) => {
      await context.registerTool(definition, { signal: registration.signal });
    }),
  ).catch(() => registration.abort());
  return () => registration.abort();
}
