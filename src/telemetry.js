import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * Optional Failproof AI observability (@failproofai/sdk).
 * Everything here is a no-op unless FAILPROOFAI_ENABLED=true, and telemetry
 * failures are logged but never allowed to break a job.
 */
let sdk = null;

const warn = (err) => console.warn(`[failproofai] ${err?.message || err}`);
const safe = (fn) => {
  try {
    return fn();
  } catch (err) {
    warn(err);
  }
};

export async function initTelemetry() {
  if (!config.failproof.enabled || sdk) return;
  try {
    const mod = await import("@failproofai/sdk");
    mod.configure({ environment: config.failproof.environment });
    // The SDK never installs signal handlers itself; flush so containers don't lose the last events.
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        try {
          mod.flushSync();
        } finally {
          process.exit(0);
        }
      });
    }
    sdk = mod;
    console.log(`[failproofai] telemetry on (environment: ${config.failproof.environment})`);
  } catch (err) {
    warn(`telemetry disabled: ${err.message}`);
  }
}

export async function flushTelemetry() {
  if (sdk) await safe(() => sdk.flush());
}

// Keep traces small and avoid shipping repo source by default.
const clip = (s, n = 500) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…[${s.length} chars]` : s);
function shrinkInput(input) {
  if (config.failproof.captureContent || !input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? clip(v, 200) : v]));
}

/**
 * One agent run = one Failproof session. `sessionId` should be your job id so the dashboard
 * and your own logs share an identifier. The body receives a handle to set the final outcome
 * ("success", or one of "failed" | "error" | "timeout" | "rejected" to mark the run failed).
 */
export function runTracked({ sessionId, goal, fields = {} }, body) {
  if (!sdk) return body({ setOutcome() {} });
  const options = { sessionId, goal: clip(goal, 300), ...fields };
  return sdk.agent("git-pr-ai", options, () =>
    body({
      setOutcome(outcome, summary) {
        options.outcome = outcome; // read when the agent scope closes
        if (summary) options.summary = clip(String(summary), 1000);
      },
    })
  );
}

export async function traceModel(model, messages, call) {
  if (!sdk) return call();
  const requestId = randomUUID();
  const started = Date.now();
  safe(() =>
    sdk.event.modelRequest({ model, requestId, ...(config.failproof.captureContent ? { messages } : {}) })
  );
  try {
    const response = await call();
    safe(() =>
      sdk.event.modelResponse({
        model: response.model ?? model,
        requestId,
        stopReason: response.stop_reason,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        duration_ms: Date.now() - started,
        ...(config.failproof.captureContent ? { content: response.content, role: "assistant" } : {}),
      })
    );
    return response;
  } catch (error) {
    // Always close the pair, or the dashboard shows the call running forever.
    safe(() =>
      sdk.event.modelResponse({
        model,
        requestId,
        stopReason: "error",
        fw_error: String(error?.message || error),
        duration_ms: Date.now() - started,
      })
    );
    throw error;
  }
}

/** `call` resolves to { content, isError } (the toolbox contract). */
export async function traceTool(toolName, toolCallId, input, call) {
  if (!sdk) return call();
  safe(() => sdk.event.toolUse({ toolName, toolCallId, input: shrinkInput(input) }));
  try {
    const result = await call();
    safe(() =>
      sdk.event.toolResult({
        toolName,
        toolCallId,
        output: config.failproof.captureContent ? result.content : clip(result.content),
        ...(result.isError ? { error: clip(result.content, 300) } : {}),
      })
    );
    return result;
  } catch (error) {
    safe(() => sdk.event.toolResult({ toolName, toolCallId, error: String(error?.message || error) }));
    throw error;
  }
}

/** Pipeline stages that aren't model or tool calls (final tests, opening the PR) show up as hooks. */
export async function traceStep(name, call, outcomeOf = () => "success") {
  if (!sdk) return call();
  const hookId = randomUUID();
  safe(() => sdk.event.hookTriggered({ hookName: name, hookId }));
  try {
    const result = await call();
    safe(() => sdk.event.hookCompleted({ hookName: name, hookId, outcome: outcomeOf(result) }));
    return result;
  } catch (error) {
    safe(() =>
      sdk.event.hookCompleted({ hookName: name, hookId, outcome: "error", error: String(error?.message || error) })
    );
    throw error;
  }
}
