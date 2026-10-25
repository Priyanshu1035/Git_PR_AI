import crypto from "node:crypto";
import { redact } from "./config.js";

const MAX_JOBS_KEPT = 200;
const MAX_LOG_LINES = 500;

/** Minimal in-memory job queue. Swap for BullMQ + Redis when you need persistence or multiple workers. */
export function createQueue({ concurrency, handler }) {
  const jobs = new Map();
  const pending = [];
  let active = 0;

  const makeLogger = (job) => (message) => {
    const clean = redact(message);
    job.logs.push(`${new Date().toISOString()}  ${clean}`);
    if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
    console.log(`[${job.id.slice(0, 8)}] ${clean}`);
  };

  function pump() {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active++;
      job.status = "running";
      job.startedAt = new Date().toISOString();

      handler(job, makeLogger(job))
        .then((result) => {
          job.status = "completed";
          job.result = result;
        })
        .catch((err) => {
          job.status = "failed";
          job.error = redact(err?.message || err);
          makeLogger(job)(`FAILED: ${job.error}`);
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          active--;
          pump();
        });
    }
  }

  function enqueue({ repo, issueNumber }) {
    const existing = [...jobs.values()].find(
      (j) => j.repo === repo && j.issueNumber === issueNumber && ["queued", "running"].includes(j.status)
    );
    if (existing) return { job: existing, duplicate: true };

    const job = {
      id: crypto.randomUUID(),
      repo,
      issueNumber,
      status: "queued",
      logs: [],
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);

    if (jobs.size > MAX_JOBS_KEPT) {
      for (const [id, j] of jobs) {
        if (!["queued", "running"].includes(j.status)) {
          jobs.delete(id);
          break;
        }
      }
    }

    pending.push(job);
    pump();
    return { job, duplicate: false };
  }

  const get = (id) => jobs.get(id);
  const list = () =>
    [...jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ logs, ...rest }) => rest);

  return { enqueue, get, list };
}
