import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config, isRepoAllowed, redact } from "./config.js";
import { createQueue } from "./queue.js";
import { runFixJob } from "./services/pipeline.js";
import { initTelemetry } from "./telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const queue = createQueue({ concurrency: config.concurrency, handler: runFixJob });
const app = express();

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// --- GitHub webhook (raw body required for signature verification) ---
app.post("/webhooks/github", express.raw({ type: "application/json", limit: "5mb" }), (req, res) => {
  if (!config.webhookSecret) return res.status(503).json({ error: "Webhook secret not configured" });

  const expected = "sha256=" + crypto.createHmac("sha256", config.webhookSecret).update(req.body).digest("hex");
  if (!safeEqual(req.get("x-hub-signature-256") || "", expected)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const event = req.get("x-github-event");
  if (event === "ping") return res.json({ ok: true });

  if (event === "issues" && payload.action === "labeled" && payload.label?.name === config.triggerLabel) {
    const repo = payload.repository.full_name;
    if (!isRepoAllowed(repo)) return res.status(403).json({ error: "Repository not allowed" });
    const { job, duplicate } = queue.enqueue({ repo, issueNumber: payload.issue.number });
    return res.status(202).json({ jobId: job.id, duplicate });
  }

  res.json({ ignored: true });
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Authenticated API ---
app.use("/api", (req, res, next) => {
  if (!safeEqual(req.get("x-api-key") || "", config.apiKey)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.post("/api/fix", (req, res) => {
  const { repo, issueNumber } = req.body || {};
  const n = Number(issueNumber);

  if (typeof repo !== "string" || !REPO_RE.test(repo)) return res.status(400).json({ error: "repo must look like 'owner/name'" });
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: "issueNumber must be a positive integer" });
  if (!isRepoAllowed(repo)) return res.status(403).json({ error: "Repository is not in ALLOWED_REPOS" });

  const { job, duplicate } = queue.enqueue({ repo, issueNumber: n });
  res.status(202).json({ jobId: job.id, status: job.status, duplicate });
});

app.get("/api/jobs", (_req, res) => res.json(queue.list()));

app.get("/api/jobs/:id", (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(redact(err.stack || err));
  res.status(500).json({ error: "Internal error" });
});

await initTelemetry();

app.listen(config.port, () => {
  console.log(`Git_PR AI listening on :${config.port} (model: ${config.model})`);
  if (config.allowedRepos.length === 0) console.warn("ALLOWED_REPOS is empty: all fix requests will be rejected.");
  if (!config.sandboxImage) console.warn("SANDBOX_DOCKER_IMAGE not set: repo tests run directly on this host. Use Docker for untrusted repos.");
});
