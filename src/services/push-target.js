/**
 * Decide whether to push the fix branch straight to the target repo or to a fork.
 * mode: "auto"   -> push directly if the token has write access, otherwise fork
 *       "always" -> always use a fork (keeps the upstream repo free of bot branches)
 *       "never"  -> never fork; fail if there is no write access
 */
export function decidePushStrategy({ canPush, mode = "auto" }) {
  if (mode === "always") return "fork";
  if (mode === "never") {
    if (!canPush) throw new Error("No push access to this repository and FORK_MODE=never");
    return "direct";
  }
  return canPush ? "direct" : "fork";
}
