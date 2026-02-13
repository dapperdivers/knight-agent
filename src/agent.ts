import { query, type ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
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
import {
  executeNatsRespond,
  executeWebSearch,
  executeWebFetch,
  type NatsRespondParams,
  type WebSearchParams,
  type WebFetchParams,
} from "./tools/index.js";
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

  // Build the full prompt with prefilled context
  const fullPrompt = [
    ...contextMessages.map((m) => `[${m.role}]: ${m.content}`),
    ...(skillMsg ? [`[user]: ${skillMsg.content}`] : []),
    taskMessage,
  ].join("\n\n---\n\n");

  logger.info(
    {
      taskId: task.metadata?.taskId,
      domain,
      knightName,
      promptLayers: {
        system: systemPrompt.length,
        context: contextMessages.length,
        skill: !!skillMsg,
        task: taskMessage.length,
      },
    },
    "Executing task with layered prompt",
  );

  const options: ClaudeAgentOptions = {
    system_prompt: systemPrompt,
    model: config.model,
    max_tokens: config.maxTokens,
    cwd: config.workspaceDir,
    permission_mode: "acceptEdits",
    allowed_tools: [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "nats_respond",
      "web_search",
      "web_fetch",
    ],
  };

  let output = "";
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    for await (const message of query({
      prompt: fullPrompt,
      options,
      // Custom tool handler
      toolHandler: async (toolName: string, toolInput: Record<string, unknown>) => {
        switch (toolName) {
          case "nats_respond":
            return executeNatsRespond(toolInput as unknown as NatsRespondParams);
          case "web_search":
            return executeWebSearch(toolInput as unknown as WebSearchParams);
          case "web_fetch":
            return executeWebFetch(toolInput as unknown as WebFetchParams);
          default:
            throw new Error(`Unknown custom tool: ${toolName}`);
        }
      },
    })) {
      // Collect output from text blocks
      if ("content" in message && Array.isArray(message.content)) {
        for (const block of message.content) {
          if ("type" in block && block.type === "text" && "text" in block) {
            output += block.text;
          }
        }
      }

      // Collect telemetry from result message
      if ("subtype" in message) {
        const result = message as Record<string, unknown>;
        if (result.total_cost_usd) totalCost = result.total_cost_usd as number;
        if (result.modelUsage) {
          const usage = result.modelUsage as Record<string, { input_tokens?: number; output_tokens?: number }>;
          for (const model of Object.values(usage)) {
            totalInputTokens += model.input_tokens ?? 0;
            totalOutputTokens += model.output_tokens ?? 0;
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
