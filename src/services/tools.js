import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "../config.js";
import { checkChangedFiles, describe } from "../guardrails/rules.js";

const execFileP = promisify(execFile);

const MAX_OUTPUT = 12_000;
const MAX_READ_BYTES = 300_000;
const MAX_WRITE_BYTES = 200_000;
const MAX_READ_LINES = 400;

const clip = (s, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n...[truncated ${s.length - n} chars]` : s);

export function createToolbox({ repoPath, sandbox, log }) {
  const root = path.resolve(repoPath);
  const changedFiles = new Set();
  const state = { finished: null };

  const rel = (abs) => path.relative(root, abs).split(path.sep).join("/") || ".";

  function resolveInside(relative) {
    if (typeof relative !== "string" || !relative.trim()) throw new Error("`path` is required");
    const abs = path.resolve(root, relative);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("Path escapes the repository");
    return abs;
  }

  async function assertRealInside(abs) {
    const real = await fs.realpath(abs);
    const realRoot = await fs.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error("Path resolves outside the repository (symlink)");
    }
  }

  function assertWritable(abs) {
    const r = rel(abs);
    const check = checkChangedFiles([r]);
    if (!check.allowed) throw new Error(`Writing to ${r} is not allowed (${describe(check.violations)})`);
  }

  async function git(args) {
    try {
      const { stdout } = await execFileP("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      if (err.code === 1 && !err.stderr) return ""; // git grep: no matches
      throw new Error(err.stderr || err.message);
    }
  }

  const handlers = {
    async list_files({ path_prefix = "" }) {
      const prefix = path_prefix ? rel(resolveInside(path_prefix)) : ".";
      const out = (await git(["ls-files", "--", prefix])).trim().split("\n").filter(Boolean);
      if (out.length === 0) return "No tracked files found.";
      const shown = out.slice(0, 400).join("\n");
      return out.length > 400 ? `${shown}\n...[${out.length - 400} more files; narrow with path_prefix]` : shown;
    },

    async search_code({ query, regex = false, path_prefix = "" }) {
      if (!query) throw new Error("`query` is required");
      const prefix = path_prefix ? rel(resolveInside(path_prefix)) : ".";
      const out = await git(["grep", "-n", "-I", "-i", regex ? "-E" : "-F", "-e", query, "--", prefix]);
      if (!out.trim()) return "No matches.";
      const lines = out.trim().split("\n").map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
      const shown = lines.slice(0, 80).join("\n");
      return lines.length > 80 ? `${shown}\n...[${lines.length - 80} more matches; refine your query]` : shown;
    },

    async read_file({ path: p, start_line = 1, end_line }) {
      const abs = resolveInside(p);
      await assertRealInside(abs);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new Error("Not a file");
      if (stat.size > MAX_READ_BYTES) throw new Error(`File too large (${stat.size} bytes). Use search_code instead.`);

      const lines = (await fs.readFile(abs, "utf8")).split("\n");
      const start = Math.max(1, Number(start_line) || 1);
      const end = Math.min(lines.length, Number(end_line) || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
      const body = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i}\t${line}`)
        .join("\n");
      return `${rel(abs)} (lines ${start}-${end} of ${lines.length})\n${body}`;
    },

    async write_file({ path: p, content }) {
      if (typeof content !== "string") throw new Error("`content` must be a string");
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new Error("Content too large");
      const abs = resolveInside(p);
      assertWritable(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await assertRealInside(path.dirname(abs));
      await fs.writeFile(abs, content, "utf8");
      changedFiles.add(rel(abs));
      return `Wrote ${rel(abs)} (${content.split("\n").length} lines)`;
    },

    async replace_in_file({ path: p, old_str, new_str }) {
      if (typeof old_str !== "string" || typeof new_str !== "string") throw new Error("`old_str` and `new_str` are required");
      if (!old_str) throw new Error("`old_str` must not be empty");
      const abs = resolveInside(p);
      assertWritable(abs);
      await assertRealInside(abs);

      const original = await fs.readFile(abs, "utf8");
      const count = original.split(old_str).length - 1;
      if (count === 0) throw new Error("old_str not found. Re-read the file and copy the text exactly (including whitespace).");
      if (count > 1) throw new Error(`old_str matches ${count} places. Include more surrounding context so it is unique.`);

      await fs.writeFile(abs, original.replace(old_str, () => new_str), "utf8");
      changedFiles.add(rel(abs));
      return `Edited ${rel(abs)}`;
    },

    async run_tests() {
      const result = await sandbox.runTests();
      const label = result.passed === null ? "NO TESTS" : result.passed ? "PASSED" : "FAILED";
      return `Tests ${label}\n${result.output}`;
    },

    async finish({ status, summary }) {
      if (!["fixed", "cannot_fix"].includes(status)) throw new Error("status must be 'fixed' or 'cannot_fix'");
      if (!summary) throw new Error("summary is required");
      state.finished = { status, summary: String(summary) };
      return "Done.";
    },
  };

  const definitions = [
    {
      name: "list_files",
      description: "List files tracked by git, optionally under a directory prefix. Start here to understand the layout.",
      input_schema: { type: "object", properties: { path_prefix: { type: "string", description: "e.g. 'src/utils'" } } },
    },
    {
      name: "search_code",
      description: "Case-insensitive search across tracked files. Returns file:line:text matches. Fixed-string by default.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean", description: "Treat query as an extended regex" },
          path_prefix: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "read_file",
      description: "Read a file with line numbers. Returns up to 400 lines per call; use start_line/end_line to page.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } },
        required: ["path"],
      },
    },
    {
      name: "replace_in_file",
      description: "Replace one exact, unique occurrence of old_str with new_str. Preferred way to edit existing files.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } },
        required: ["path", "old_str", "new_str"],
      },
    },
    {
      name: "write_file",
      description: "Create a new file or fully overwrite one (e.g. adding a test file). Use replace_in_file for small edits.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "run_tests",
      description: "Install dependencies (first call only) and run the project's test suite. Returns pass/fail and output.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "finish",
      description: "Call exactly once when done. status='fixed' if you made a fix you believe is correct, otherwise 'cannot_fix' with an explanation of what you found.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["fixed", "cannot_fix"] },
          summary: { type: "string", description: "Root cause, what you changed and why (fixed), or your analysis and blockers (cannot_fix). Markdown ok." },
        },
        required: ["status", "summary"],
      },
    },
  ];

  async function execute(name, input = {}) {
    const handler = handlers[name];
    if (!handler) return { content: `Unknown tool: ${name}`, isError: true };
    log(`tool ${name} ${clip(JSON.stringify(input), 140)}`);
    try {
      return { content: clip(redact(await handler(input))), isError: false };
    } catch (err) {
      return { content: `Error: ${redact(err.message)}`, isError: true };
    }
  }

  return { definitions, execute, changedFiles, state };
}
