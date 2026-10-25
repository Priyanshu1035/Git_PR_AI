import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { config } from "../config.js";

export async function cloneRepo({ owner, repo, branch, dest }) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const url = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
  await simpleGit().clone(url, dest, ["--depth", "1", "--branch", branch]);

  const git = simpleGit(dest);
  await git.addConfig("user.name", config.gitUserName);
  await git.addConfig("user.email", config.gitUserEmail);
  return git;
}

export async function addRemote(git, name, owner, repo) {
  const url = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}.git`;
  await git.addRemote(name, url);
}

export async function removeWorkspace(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}
