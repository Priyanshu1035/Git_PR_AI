import test from "node:test";
import assert from "node:assert/strict";

process.env.API_KEY ||= "test";
process.env.GITHUB_TOKEN ||= "test";
process.env.ANTHROPIC_API_KEY ||= "test";
delete process.env.FAILPROOFAI_ENABLED;

const t = await import("../src/telemetry.js");

test("everything is a transparent no-op when disabled", async () => {
  await t.initTelemetry();
  const out = await t.runTracked({ sessionId: "x", goal: "y" }, async (run) => {
    run.setOutcome("failed", "ignored");
    const tool = await t.traceTool("t", "c", {}, async () => ({ content: "v", isError: false }));
    const model = await t.traceModel("m", [], async () => "reply");
    const step = await t.traceStep("s", async () => 42);
    return [tool.content, model, step];
  });
  assert.deepEqual(out, ["v", "reply", 42]);
  await t.flushTelemetry();
});
