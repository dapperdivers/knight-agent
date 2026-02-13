import type { WorkspaceFiles, KnightIdentity } from "../workspace/loader.js";

/**
 * Layered prompt architecture for knight agents.
 *
 * Layer 1: System prompt (highest trust) — identity + hard constraints
 * Layer 2: Context injection (prefilled messages) — soul, memory, tools
 * Layer 3: Skills (on-demand) — loaded per-task
 * Layer 4: Task (user message) — the actual request
 */

/**
 * Build Layer 1: System prompt.
 *
 * Short, immutable, contract-style. This is the knight's core identity
 * and non-negotiable constraints. Should be <500 tokens.
 */
export function buildSystemPrompt(identity: KnightIdentity, domain: string): string {
  return `You are ${identity.name} ${identity.emoji}, a specialized AI agent in the Knights of the Round Table.

<role>${identity.description}</role>

<constraints>
- You are a task-execution agent. Complete the task, return the result, then stop.
- Respond via the nats-respond tool when available, or return structured output.
- Stay within your domain: ${domain}.
- Never take external actions (send emails, post publicly, modify infrastructure) without explicit permission in the task.
- If uncertain, state your uncertainty rather than guessing.
- Keep responses focused and actionable.
</constraints>

<output_contract>
When returning results, use structured formats:
- For analysis: provide findings, severity, recommendations
- For data: provide structured JSON when possible
- For reports: use clear sections with headers
Always include confidence level (high/medium/low) for analytical claims.
</output_contract>`;
}

/**
 * Build Layer 2: Context injection messages.
 *
 * These are prefilled as a user→assistant exchange before the actual task.
 * The assistant "acknowledgment" anchors the personality more strongly
 * than system prompt alone (the model treats its own prior responses
 * as stronger behavioral evidence).
 */
export function buildContextMessages(
  workspace: WorkspaceFiles,
  identity: KnightIdentity,
): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Soul injection — personality and behavioral guidance
  if (workspace.soul) {
    messages.push({
      role: "user",
      content: `<soul>\n${workspace.soul}\n</soul>\n\nEmbody this identity in all interactions.`,
    });
    messages.push({
      role: "assistant",
      content: `Understood. I am ${identity.name} ${identity.emoji}. Identity loaded.`,
    });
  }

  // Operating instructions + tool knowledge
  const contextParts: string[] = [];
  if (workspace.agents) {
    contextParts.push(`<operating_instructions>\n${workspace.agents}\n</operating_instructions>`);
  }
  if (workspace.tools) {
    contextParts.push(`<tools>\n${workspace.tools}\n</tools>`);
  }

  if (contextParts.length > 0) {
    messages.push({
      role: "user",
      content: contextParts.join("\n\n"),
    });
    messages.push({
      role: "assistant",
      content: "Instructions and tool configuration loaded. Ready for tasks.",
    });
  }

  // Memory injection — recent context + long-term
  const memoryParts: string[] = [];
  if (workspace.memory) {
    memoryParts.push(`<long_term_memory>\n${workspace.memory}\n</long_term_memory>`);
  }
  if (workspace.recentMemory.length > 0) {
    memoryParts.push(
      `<recent_memory>\n${workspace.recentMemory.join("\n\n---\n\n")}\n</recent_memory>`,
    );
  }

  if (memoryParts.length > 0) {
    messages.push({
      role: "user",
      content: memoryParts.join("\n\n"),
    });
    messages.push({
      role: "assistant",
      content: "Memory context loaded. Continuity established.",
    });
  }

  return messages;
}

/**
 * Build Layer 3: Skill injection for a specific task.
 *
 * Skills are loaded on-demand based on task metadata.
 * Returns null if no skill applies.
 */
export function buildSkillContext(
  skillContent: string | null,
  skillName: string,
): { role: "user"; content: string } | null {
  if (!skillContent) return null;

  return {
    role: "user",
    content: `<skill name="${skillName}">\n${skillContent}\n</skill>\n\nApply this skill's instructions to the following task.`,
  };
}

/**
 * Build Layer 4: The actual task message.
 *
 * Wraps the raw task with metadata for structured execution.
 */
export function buildTaskMessage(
  task: string,
  metadata?: { taskId?: string; domain?: string; replySubject?: string },
): string {
  const parts: string[] = [];

  if (metadata?.taskId) {
    parts.push(`<task_metadata>
  task_id: ${metadata.taskId}
  domain: ${metadata.domain ?? "general"}
  ${metadata.replySubject ? `reply_subject: ${metadata.replySubject}` : ""}
</task_metadata>`);
  }

  parts.push(`<task>\n${task}\n</task>`);

  return parts.join("\n\n");
}
