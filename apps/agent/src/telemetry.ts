/**
 * OpenTelemetry instrumentation — opt-in, zero-overhead by default.
 *
 * Sym instruments its model calls with the `@opentelemetry/api` tracer using the
 * `gen_ai.*` semantic conventions. With NO OpenTelemetry SDK registered the
 * tracer is a no-op — the default single-tenant deployment pays nothing and
 * needs no extra dependencies.
 *
 * To collect traces, an operator runs the agent with a standard OTel SDK and
 * points it at a collector, e.g.:
 *
 *   npm i @opentelemetry/auto-instrumentations-node
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
 *   OTEL_SERVICE_NAME=sym \
 *   node --import @opentelemetry/auto-instrumentations-node/register dist/index.js
 *
 * The auto-instrumentation traces the inbound Slack HTTP request; Sym's
 * `gen_ai.chat` span then nests beneath it, carrying the model id, reasoning
 * effort, and token usage for per-turn LLM cost/latency observability.
 */

import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

import type { Usage } from '@sym/contracts';

const tracer = trace.getTracer('sym-agent');

/**
 * Run `fn` inside a new active span named `name` with the given attributes.
 * Records exceptions + an ERROR status on throw, always ends the span, and
 * returns `fn`'s result. A no-op (just calls `fn`) when no SDK is registered.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Set `gen_ai.usage.*` token attributes on the current active span from a Sym
 * `Usage`. No-op when usage is absent or no span is active.
 */
export function recordGenAiUsage(usage: Usage | undefined): void {
  if (usage === undefined) return;
  trace.getActiveSpan()?.setAttributes({
    'gen_ai.usage.input_tokens': usage.promptTokens,
    'gen_ai.usage.output_tokens': usage.completionTokens,
  });
}
