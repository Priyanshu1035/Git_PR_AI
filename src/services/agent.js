import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT, buildTaskPrompt } from "../prompts.js";
import { traceModel, traceTool } from "../telemetry.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Tool-use loop: the model explores the repo, edits files, runs tests, and calls `finish`.
 * Results are read from toolbox.state.finished and toolbox.changedFiles.
 */
export async function runAgent({ issue, repoFullName, toolbox, log }) {
  const messages = [{ role: "user", content: buildTaskPrompt(issue, repoFullName) }];
  let totalTokens = 0;

  for (let step = 1; step <= config.maxSteps; step++) {
    const response = await traceModel(config.model, messages, () =>
      client.messages.create({
        model: config.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: toolbox.definitions,
        messages,
      })
    );

    totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) log(`agent: ${block.text.trim().slice(0, 300)}`);
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      log("Agent stopped without calling finish");
      break;
    }

    const results = [];
    for (const use of toolUses) {
      const { content, isError } = await traceTool(use.name, use.id, use.input, () => toolbox.execute(use.name, use.input));
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content,
        ...(isError ? { is_error: true } : {}),
      });
      if (toolbox.state.finished) break;
    }

    if (toolbox.state.finished) {
      log(`Agent finished in ${step} steps (${totalTokens} tokens)`);
      return { steps: step, totalTokens };
    }

    messages.push({ role: "user", content: results });

    if (totalTokens > config.maxTotalTokens) {
      log(`Token budget exceeded (${totalTokens}); stopping`);
      break;
    }
  }

  return { steps: config.maxSteps, totalTokens };
}
