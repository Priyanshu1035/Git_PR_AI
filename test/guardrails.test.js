import test from "node:test";
import assert from "node:assert/strict";
import { checkChangedFiles, checkIssueLabel, checkPullRequestLabel } from "../src/guardrails/rules.js";

test("blocks .env files at any depth, allows normal files", () => {
  for (const f of [".env", ".env.local", "apps/web/.env.production", "./.env", "\\.env"]) {
    assert.equal(checkChangedFiles([f]).allowed, false, f);
  }
  assert.equal(checkChangedFiles(["src/environment.js", "docs/dotenv.md"]).allowed, true);
});

test("blocks .git and .github paths", () => {
  assert.equal(checkChangedFiles([".github/workflows/ci.yml"]).allowed, false);
  assert.equal(checkChangedFiles([".git/config"]).allowed, false);
});

test("reports every violating file", () => {
  const r = checkChangedFiles(["src/a.js", ".env", ".github/x.yml"]);
  assert.deepEqual(r.violations.map((v) => v.file), [".env", ".github/x.yml"]);
});

test("issue must carry the AI label (case-insensitive, string or object labels)", () => {
  assert.equal(checkIssueLabel(["bug", "AI-Fix"], "ai-fix").allowed, true);
  assert.equal(checkIssueLabel([{ name: "ai-fix" }], "ai-fix").allowed, true);
  assert.equal(checkIssueLabel(["bug"], "ai-fix").allowed, false);
  assert.equal(checkIssueLabel([], "ai-fix").allowed, false);
});

test("PR must carry ai-generated", () => {
  assert.equal(checkPullRequestLabel(["ai-generated"]).allowed, true);
  assert.equal(checkPullRequestLabel(["bug"]).allowed, false);
});
