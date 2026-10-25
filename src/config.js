import "dotenv/config";
import os from "node:os";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const list = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  apiKey: required("API_KEY"),
  githubToken: required("GITHUB_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
  allowedRepos: list(process.env.ALLOWED_REPOS),
  triggerLabel: process.env.TRIGGER_LABEL || "ai-fix",
  workdir: process.env.WORKDIR || path.join(os.tmpdir(), "git-pr-ai"),
  concurrency: Number(process.env.CONCURRENCY || 1),
  maxSteps: Number(process.env.MAX_STEPS || 25),
  maxTotalTokens: Number(process.env.MAX_TOTAL_TOKENS || 500000),
  forkMode: ["auto", "always", "never"].includes(process.env.FORK_MODE) ? process.env.FORK_MODE : "auto",
  failproof: {
    enabled: process.env.FAILPROOFAI_ENABLED === "true",
    environment: process.env.FAILPROOFAI_ENVIRONMENT || "dev", // no commas allowed
    captureContent: process.env.FAILPROOFAI_CAPTURE_CONTENT === "true",
  },
  requireGreenTests: process.env.REQUIRE_GREEN_TESTS !== "false",
  installCommand: process.env.INSTALL_COMMAND || "",
  testCommand: process.env.TEST_COMMAND || "",
  sandboxImage: process.env.SANDBOX_DOCKER_IMAGE || "",
  sandboxNetwork: process.env.SANDBOX_DOCKER_NETWORK || "bridge",
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS || 300000),
  gitUserName: process.env.GIT_USER_NAME || "Git_PR AI",
  gitUserEmail: process.env.GIT_USER_EMAIL || "git-pr-ai@users.noreply.github.com",
};

export function isRepoAllowed(fullName) {
  return config.allowedRepos.includes(String(fullName).toLowerCase());
}

/** Strip secrets from anything we log or return to a client. */
export function redact(text) {
  let out = String(text ?? "");
  for (const secret of [config.githubToken, config.anthropicApiKey, config.apiKey, config.webhookSecret]) {
    if (secret) out = out.split(secret).join("***");
  }
  return out;
}
