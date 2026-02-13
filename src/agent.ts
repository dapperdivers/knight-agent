import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { join } from "path";
import type { KnightConfig } from "./config.js";
import type { WorkspaceFiles } from "./workspace/loader.js";
import { parseIdentity } from "./workspace/loader.js";
import {
  buildSystemPrompt,
  buildContextMessages,
  buildSkillContext,
  buildTaskMessage,
} from "./prompt/layers.js";
import { discoverSkills, loadSkill } from "./workspace/skills.js";
import type { Logger } from "pino";

export interface TaskRequest {
  message: string;
  metadata?: {
    taskId?: string;
    domain?: string;
    replySubject?: string;
    knight?: string;
    skill?: string;
    skillContent?: string;
  };
}

export interface TaskResult {
  success: boolean;
  output: string;
  taskId?: string;
  cost?: number;
  tokens?: { input: number; output: number };
  durationMs: number;
}

/**
 * Execute a task using the Claude Agent SDK with layered prompt architecture.
 */
export async function executeTask(
  task: TaskRequest,
  config: KnightConfig,
  workspace: WorkspaceFiles,
  logger: Logger,
): Promise<TaskResult> {
  const start = Date.now();
  const identity = parseIdentity(workspace.identity);
  const knightName = config.knightName ?? identity.name;
  const domain = task.metadata?.domain ?? "general";

  // Discover available skills (progressive disclosure — metadata only)
  const skills = await discoverSkills(join(config.workspaceDir, "skills"));

  // If task specifies a skill, load it fully
  let skillContent: string | null = task.metadata?.skillContent ?? null;
  if (!skillContent && task.metadata?.skill) {
    const matchedSkill = skills.find((s) => s.name === task.metadata!.skill);
    if (matchedSkill) {
      const full = await loadSkill(matchedSkill.path);
      skillContent = full?.instructions ?? null;
    }
  }

  // Layer 1: System prompt (with skill catalog for discovery)
  const systemPrompt = buildSystemPrompt(
    { ...identity, name: knightName },
    domain,
    skills,
  );

  // Layer 2: Context messages (prefilled conversation)
  const contextMessages = buildContextMessages(workspace, {
    ...identity,
    name: knightName,
  });

  // Layer 3: Skill injection (optional, loaded on-demand)
  const skillMsg = buildSkillContext(
    skillContent,
    task.metadata?.skill ?? "none",
  );

  // Layer 4: Task message
  const taskMessage = buildTaskMessage(task.message, task.metadata);

  // Build the full prompt — context + skill + task as a single prompt string
  // The SDK handles this as the user message; system prompt is separate
  const promptParts: string[] = [];

  // Inject context as structured blocks in the prompt
  for (const msg of contextMessages) {
    promptParts.push(msg.content);
  }
  if (skillMsg) {
    promptParts.push(skillMsg.content);
  }
  promptParts.push(taskMessage);

  const fullPrompt = promptParts.join("\n\n---\n\n");

  logger.info(
    {
      taskId: task.metadata?.taskId,
      domain,
      knightName,
      skillsAvailable: skills.length,
      skillActivated: task.metadata?.skill ?? null,
      promptLength: fullPrompt.length,
    },
    "Executing task with layered prompt",
  );

  const options: Options = {
    systemPrompt,
    model: config.model,
    cwd: config.workspaceDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 25,
    persistSession: false,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  };

  let output = "";
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    for await (const message of query({ prompt: fullPrompt, options })) {
      if (message.type === "assistant") {
        // Extract text from assistant message content blocks
        for (const block of message.message.content) {
          if (block.type === "text") {
            output += block.text;
          }
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          totalCost = message.total_cost_usd;
          output = message.result || output;
          for (const [, usage] of Object.entries(message.modelUsage)) {
            totalInputTokens += usage.inputTokens ?? 0;
            totalOutputTokens += usage.outputTokens ?? 0;
          }
        }
      }
    }

    const durationMs = Date.now() - start;
    logger.info(
      {
        taskId: task.metadata?.taskId,
        durationMs,
        cost: totalCost,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
      },
      "Task completed",
    );

    return {
      success: true,
      output,
      taskId: task.metadata?.taskId,
      cost: totalCost,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ taskId: task.metadata?.taskId, error: errMsg, durationMs }, "Task failed");

    return {
      success: false,
      output: `Error: ${errMsg}`,
      taskId: task.metadata?.taskId,
      durationMs,
    };
  }
}
