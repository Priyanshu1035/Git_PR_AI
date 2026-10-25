import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "fp-home-"));
process.env.FAILPROOFAI_HOME = home;
process.env.FAILPROOFAI_ENABLED = "true";
process.env.FAILPROOFAI_ENVIRONMENT = "test";
process.env.API_KEY ||= "test";
process.env.GITHUB_TOKEN ||= "test";
process.env.ANTHROPIC_API_KEY ||= "test";

const t = await import("../src/telemetry.js");

async function readEvents() {
  const out = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else for (const line of (await fs.readFile(p, "utf8")).split("\n").filter(Boolean)) out.push(JSON.parse(line));
    }
  }
  await walk(home);
  return out;
}

test("a run emits a correlated session with model, tool, hook and agent events", async () => {
  await t.initTelemetry();

  const result = await t.runTracked({ sessionId: "job-123", goal: "Fix a bug", fields: { fw_repo: "me/app" } }, async (run) => {
    const reply = await t.traceModel("test-model", [], async () => ({
      model: "test-model", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 },
    }));
    await t.traceTool("read_file", "call-1", { path: "a.js" }, async () => ({ content: "ok", isError: false }));
    await t.traceTool("replace_in_file", "call-2", { path: "a.js" }, async () => ({ content: "Error: not found", isError: true }));
    await t.traceStep("final_tests", async () => ({ passed: false }), (r) => (r.passed ? "success" : "failed"));
    run.setOutcome("rejected", "agent could not fix it");
    return reply.stop_reason;
  });
  assert.equal(result, "tool_use"); // the wrapper must pass the body's value through

  await t.flushTelemetry();
  const events = await readEvents();
  const types = events.map((e) => e.type);
  for (const expected of ["agent_start", "model_request", "model_response", "tool_use", "tool_result", "hook_triggered", "hook_completed", "agent_end"]) {
    assert.ok(types.includes(expected), `missing ${expected}; got ${types.join(",")}`);
  }
  assert.ok(events.every((e) => e.session_id === "job-123"), "all events share the job id as session");

  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.outcome ?? end.payload?.outcome, "rejected");

  const failedTool = events.filter((e) => e.type === "tool_result").find((e) => (e.error ?? e.payload?.error));
  assert.ok(failedTool, "tool error is recorded on the tool_result");
});

test("an exception inside the run is re-thrown and recorded as failed", async () => {
  await assert.rejects(
    t.runTracked({ sessionId: "job-boom", goal: "x" }, async () => { throw new Error("boom"); }),
    /boom/
  );
  await t.flushTelemetry();
  const events = (await readEvents()).filter((e) => e.session_id === "job-boom");
  assert.ok(events.some((e) => e.type === "error"));
  const end = events.find((e) => e.type === "agent_end");
  assert.equal(end.outcome ?? end.payload?.outcome, "failed");
});
