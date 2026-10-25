import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

const octokit = new Octokit({ auth: config.githubToken, userAgent: "git-pr-ai" });

export async function getIssue(owner, repo, number) {
  const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: number });
  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
  if (issue.state !== "open") throw new Error(`Issue #${number} is not open`);

  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: number,
    per_page: 20,
  });

  return {
    number,
    title: issue.title,
    body: issue.body || "(no description)",
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    comments: comments.map((c) => ({ user: c.user?.login ?? "unknown", body: c.body })),
    url: issue.html_url,
  };
}

export async function getRepoInfo(owner, repo) {
  const { data } = await octokit.repos.get({ owner, repo });
  return { defaultBranch: data.default_branch, canPush: Boolean(data.permissions?.push) };
}

/** Fork the repo into the token owner's account and wait until it is reachable. */
export async function ensureFork(owner, repo) {
  const { data: fork } = await octokit.repos.createFork({ owner, repo, default_branch_only: true });
  for (let i = 0; i < 30; i++) {
    try {
      await octokit.repos.get({ owner: fork.owner.login, repo: fork.name });
      await new Promise((r) => setTimeout(r, 3000)); // let git data finish copying
      return { owner: fork.owner.login, repo: fork.name };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for the fork to be ready");
}

export async function createPullRequest({ owner, repo, head, base, title, body }) {
  const { data } = await octokit.pulls.create({ owner, repo, head, base, title, body, draft: true, maintainer_can_modify: true });
  return { number: data.number, url: data.html_url };
}

export async function addLabels(owner, repo, issueNumber, labels) {
  try {
    await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels });
  } catch {
    /* labels are cosmetic; never fail the job over them */
  }
}

export async function commentOnIssue(owner, repo, issueNumber, body) {
  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

/** Source of truth for what a PR really changes (paged, up to 300 files). */
export async function listPullRequestFiles(owner, repo, number) {
  const files = await octokit.paginate(octokit.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

export async function getPullRequestLabels(owner, repo, number) {
  const { data } = await octokit.issues.listLabelsOnIssue({ owner, repo, issue_number: number });
  return data.map((l) => l.name);
}

export async function closePullRequest(owner, repo, number, reason) {
  await octokit.issues.createComment({ owner, repo, issue_number: number, body: reason });
  await octokit.pulls.update({ owner, repo, pull_number: number, state: "closed" });
}
