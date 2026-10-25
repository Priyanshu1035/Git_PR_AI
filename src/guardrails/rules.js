// Single source of truth for the PR guardrails. Pure functions, no I/O.
// Used by (1) the Failproof policy file in .failproofai/policies/ and
// (2) the pipeline gates in src/services/pipeline.js.

export const PR_LABEL = "ai-generated";

const PROTECTED_PATHS = [
  { rule: "env-files", re: /(^|\/)\.env(\..*)?$/, reason: "environment/secret files must never be modified" },
  { rule: "git-internals", re: /^\.git(\/|$)/, reason: "git internals must never be modified" },
  { rule: "ci-definitions", re: /^\.github\//, reason: "CI/workflow definitions must never be modified" },
];

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
const hasLabel = (labels, wanted) =>
  (labels || []).some((l) => String(typeof l === "string" ? l : l?.name).toLowerCase() === String(wanted).toLowerCase());

/** Rule: the agent may not change .env*, .git/ or .github/. */
export function checkChangedFiles(files) {
  const violations = [];
  for (const file of files || []) {
    const f = norm(file);
    const hit = PROTECTED_PATHS.find((p) => p.re.test(f));
    if (hit) violations.push({ file: f, rule: hit.rule, reason: hit.reason });
  }
  return { allowed: violations.length === 0, violations };
}

/** Rule: the agent only works on issues that carry the AI trigger label. */
export function checkIssueLabel(labels, requiredLabel) {
  const ok = hasLabel(labels, requiredLabel);
  return {
    allowed: ok,
    violations: ok ? [] : [{ file: null, rule: "ai-label-required", reason: `issue is missing the "${requiredLabel}" label` }],
  };
}

/** Rule: the PR the agent opened must be labeled ai-generated. */
export function checkPullRequestLabel(labels, requiredLabel = PR_LABEL) {
  const ok = hasLabel(labels, requiredLabel);
  return {
    allowed: ok,
    violations: ok ? [] : [{ file: null, rule: "pr-label-required", reason: `PR is missing the "${requiredLabel}" label` }],
  };
}

export const describe = (violations) =>
  violations.map((v) => `${v.rule}${v.file ? ` (${v.file})` : ""}: ${v.reason}`).join("; ");
