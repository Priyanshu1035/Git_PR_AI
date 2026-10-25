// Failproof AI policy for the git-pr-ai agent: block writes to protected files.
// Loaded automatically by Failproof from .failproofai/policies/.
// Rules live in src/guardrails/rules.js so the pipeline gate and this policy never drift.
import { customPolicies, allow, deny } from "failproofai";
import { checkChangedFiles, describe } from "../../src/guardrails/rules.js";

// git-pr-ai's file-writing tools (see src/services/tools.js).
const WRITE_TOOLS = new Set(["write_file", "replace_in_file", "Write", "Edit"]);

customPolicies.add({
  name: "git-pr-ai/block-protected-writes",
  description: "Block edits to .env*, .git/ and .github/ files",
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    if (!WRITE_TOOLS.has(ctx.toolName)) return allow();
    const target = ctx.toolInput?.path ?? ctx.toolInput?.file_path;
    if (!target) return allow();
    const result = checkChangedFiles([target]);
    return result.allowed ? allow() : deny(`Blocked: ${describe(result.violations)}`);
  },
});
