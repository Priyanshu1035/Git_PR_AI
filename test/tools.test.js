import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.API_KEY ||= "test";
process.env.GITHUB_TOKEN ||= "test";
process.env.ANTHROPIC_API_KEY ||= "test";
const { createToolbox } = await import("../src/services/tools.js");

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gpa-test-"));
  await fs.mkdir(path.join(dir, "src"));
  await fs.writeFile(path.join(dir, "src/math.js"), "export const add = (a, b) => a - b;\n");
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const sandbox = { hasTests: false, runTests: async () => ({ passed: null, output: "" }) };
  return { dir, toolbox: createToolbox({ repoPath: dir, sandbox, log: () => {} }) };
}

test("list, search and read files", async () => {
  const { toolbox } = await makeRepo();
  assert.match((await toolbox.execute("list_files", {})).content, /src\/math\.js/);
  assert.match((await toolbox.execute("search_code", { query: "a - b" })).content, /src\/math\.js:1/);
  assert.match((await toolbox.execute("read_file", { path: "src/math.js" })).content, /1\texport const add/);
});

test("replace_in_file edits and tracks the change", async () => {
  const { dir, toolbox } = await makeRepo();
  const r = await toolbox.execute("replace_in_file", { path: "src/math.js", old_str: "a - b", new_str: "a + b" });
  assert.equal(r.isError, false);
  assert.match(await fs.readFile(path.join(dir, "src/math.js"), "utf8"), /a \+ b/);
  assert.deepEqual([...toolbox.changedFiles], ["src/math.js"]);
});

test("replace_in_file rejects missing and ambiguous matches", async () => {
  const { toolbox } = await makeRepo();
  assert.equal((await toolbox.execute("replace_in_file", { path: "src/math.js", old_str: "nope", new_str: "x" })).isError, true);
  assert.equal((await toolbox.execute("replace_in_file", { path: "src/math.js", old_str: "a", new_str: "x" })).isError, true);
});

test("path traversal and protected files are blocked", async () => {
  const { toolbox } = await makeRepo();
  assert.equal((await toolbox.execute("read_file", { path: "../../etc/passwd" })).isError, true);
  assert.equal((await toolbox.execute("write_file", { path: "../evil.txt", content: "x" })).isError, true);
  assert.equal((await toolbox.execute("write_file", { path: ".github/workflows/ci.yml", content: "x" })).isError, true);
  assert.equal((await toolbox.execute("write_file", { path: ".env", content: "x" })).isError, true);
});

test("finish records the outcome", async () => {
  const { toolbox } = await makeRepo();
  await toolbox.execute("finish", { status: "fixed", summary: "done" });
  assert.deepEqual(toolbox.state.finished, { status: "fixed", summary: "done" });
});
