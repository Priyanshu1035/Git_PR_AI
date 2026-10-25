import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const MAX_CAPTURE = 200_000;
const TAIL_CHARS = 8_000;

/**
 * Environment given to untrusted repo code. Deliberately minimal so test scripts
 * can never read GITHUB_TOKEN or ANTHROPIC_API_KEY from process.env.
 */
function minimalEnv() {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "true",
    NODE_ENV: "test",
    LANG: "C.UTF-8",
  };
}

export function run(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let cmd = "sh";
    let args = ["-c", command];

    if (config.sandboxImage) {
      cmd = "docker";
      args = [
        "run", "--rm",
        "--network", config.sandboxNetwork,
        "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
        "-v", `${cwd}:/work`, "-w", "/work",
        "-e", "CI=true", "-e", "HOME=/tmp",
      ];
      if (process.getuid) args.push("--user", `${process.getuid()}:${process.getgid()}`);
      args.push(config.sandboxImage, "sh", "-c", command);
    }

    const child = spawn(cmd, args, { cwd, env: minimalEnv(), detached: true });
    let output = "";
    let timedOut = false;

    const collect = (chunk) => {
      if (output.length < MAX_CAPTURE) output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL"); // kill the whole process group
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `Failed to start command: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

const tail = (s) => (s.length > TAIL_CHARS ? `...[earlier output omitted]\n${s.slice(-TAIL_CHARS)}` : s);

export function detectCommands(repoPath) {
  const has = (f) => fs.existsSync(path.join(repoPath, f));
  let install = config.installCommand;
  let test = config.testCommand;

  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8"));
      if (!install) {
        install = has("package-lock.json")
          ? "npm ci --ignore-scripts --no-audit --no-fund"
          : "npm install --ignore-scripts --no-audit --no-fund";
      }
      const script = pkg.scripts?.test;
      if (!test && script && !/no test specified/i.test(script)) test = "npm test";
    } catch {
      /* malformed package.json: leave commands empty */
    }
  } else if (!test && (has("pytest.ini") || has("pyproject.toml") || has("requirements.txt"))) {
    test = "python -m pytest -x -q";
  }
  return { install, test };
}

export function createSandbox(repoPath, log) {
  const { install, test } = detectCommands(repoPath);
  let installed = false;

  return {
    hasTests: Boolean(test),
    async runTests() {
      if (!test) return { passed: null, output: "No test command detected for this repository." };

      if (install && !installed) {
        log("Installing dependencies…");
        const r = await run(install, repoPath, config.commandTimeoutMs * 2);
        if (r.code !== 0) return { passed: false, output: `Dependency install failed:\n${tail(r.output)}` };
        installed = true;
      }

      log(`Running tests: ${test}`);
      const r = await run(test, repoPath, config.commandTimeoutMs);
      return {
        passed: r.code === 0 && !r.timedOut,
        output: `${r.timedOut ? "[timed out]\n" : ""}${tail(r.output)}`,
      };
    },
  };
}
