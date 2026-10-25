import test from "node:test";
import assert from "node:assert/strict";
import { decidePushStrategy } from "../src/services/push-target.js";

test("auto: direct with write access, fork without", () => {
  assert.equal(decidePushStrategy({ canPush: true, mode: "auto" }), "direct");
  assert.equal(decidePushStrategy({ canPush: false, mode: "auto" }), "fork");
});

test("always forks, even with write access", () => {
  assert.equal(decidePushStrategy({ canPush: true, mode: "always" }), "fork");
});

test("never forks and fails without write access", () => {
  assert.equal(decidePushStrategy({ canPush: true, mode: "never" }), "direct");
  assert.throws(() => decidePushStrategy({ canPush: false, mode: "never" }), /FORK_MODE=never/);
});
