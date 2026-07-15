type SpanAttribute = string | number | boolean | undefined;

interface RuntimeSpan {
  setAttribute(key: string, value: SpanAttribute): void;
}

interface RuntimeTracing {
  enterSpan<T>(name: string, callback: (span: RuntimeSpan) => T): T;
}

export function enterTelemetrySpan<T>(
  executionCtx: ExecutionContext,
  name: string,
  attributes: Record<string, SpanAttribute>,
  callback: () => T,
): T {
  const tracing = (executionCtx as ExecutionContext & { tracing?: RuntimeTracing }).tracing;
  if (!tracing) return callback();
  return tracing.enterSpan(name, (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
    return callback();
  });
}
