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
  error?: string;
  taskId?: string;
  cost?: number;
  tokens?: { input: number; output: number };
  durationMs: number;
  model?: string;
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
  const taskId = task.metadata?.taskId ?? "unknown";

  // Discover available skills from both git-synced and knight-authored locations
  const [sharedSkills, localSkills] = await Promise.all([
    discoverSkills(join(config.workspaceDir, "skills")),
    discoverSkills(join(config.workspaceDir, "local-skills")),
  ]);
  const skills = [...sharedSkills, ...localSkills];

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

  // Layer 2: Context messages (soul, tools, memory)
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

  // Build the full prompt — context + skill + task as structured blocks
  // The SDK only accepts a single prompt string, so we serialize the
  // context messages as XML-tagged blocks to preserve structure.
  const promptParts: string[] = [];

  for (const msg of contextMessages) {
    const tag = msg.role === "assistant" ? "context_ack" : "context";
    promptParts.push(`<${tag}>\n${msg.content}\n</${tag}>`);
  }
  if (skillMsg) {
    promptParts.push(skillMsg.content);
  }
  promptParts.push(taskMessage);

  const fullPrompt = promptParts.join("\n\n");

  logger.info(
    {
      taskId,
      domain,
      knightName,
      skillsAvailable: skills.length,
      skillActivated: task.metadata?.skill ?? null,
      model: config.model ?? "(sdk-default)",
      promptLength: fullPrompt.length,
    },
    "Executing task",
  );

  // Build SDK options
  const options: Options = {
    systemPrompt,
    cwd: config.workspaceDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 25,
    persistSession: false,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
  };

  // Only set model if explicitly configured — otherwise SDK uses its own default
  if (config.model) {
    options.model = config.model;
  }

  // Task timeout via AbortController
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort();
  }, config.taskTimeoutMs);
  options.abortController = abortController;

  let output = "";
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sdkModel: string | undefined;
  let sdkError: string | undefined;
  let isError = false;

  try {
    for await (const message of query({ prompt: fullPrompt, options })) {
      handleSDKMessage(message, {
        onInit: (model) => {
          sdkModel = model;
          logger.debug({ taskId, model }, "SDK session initialized");
        },
        onAssistant: (text) => {
          output += text;
        },
        onResult: (result) => {
          totalCost = result.cost;
          totalInputTokens = result.inputTokens;
          totalOutputTokens = result.outputTokens;
          isError = result.isError;
          if (result.output) output = result.output;
          if (result.isError) sdkError = result.output;
        },
      });
    }

    clearTimeout(timeoutHandle);
    const durationMs = Date.now() - start;

    if (isError) {
      logger.warn(
        { taskId, durationMs, cost: totalCost, error: sdkError, model: sdkModel },
        "Task completed with SDK error",
      );
      return {
        success: false,
        output: "",
        error: sdkError ?? "Unknown SDK error",
        taskId,
        cost: totalCost,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        durationMs,
        model: sdkModel,
      };
    }

    logger.info(
      { taskId, durationMs, cost: totalCost, tokens: { input: totalInputTokens, output: totalOutputTokens }, model: sdkModel },
      "Task completed",
    );

    return {
      success: true,
      output,
      taskId,
      cost: totalCost,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs,
      model: sdkModel,
    };
  } catch (error) {
    clearTimeout(timeoutHandle);
    const durationMs = Date.now() - start;
    const errMsg = error instanceof Error ? error.message : String(error);

    // Distinguish timeout from other errors
    const isTimeout = abortController.signal.aborted;
    const errorType = isTimeout ? "timeout" : "execution_error";

    logger.error(
      { taskId, errorType, error: errMsg, durationMs, sdkError, model: sdkModel },
      isTimeout ? "Task timed out" : "Task failed",
    );

    // If SDK returned an error message before crashing, include it
    const detailedError = sdkError
      ? `${errMsg} — SDK detail: ${sdkError}`
      : errMsg;

    return {
      success: false,
      output: "",
      error: detailedError,
      taskId,
      cost: totalCost,
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs,
      model: sdkModel,
    };
  }
}

/**
 * Structured SDK message handler — extracts relevant data from each message type.
 */
interface SDKCallbacks {
  onInit?: (model: string) => void;
  onAssistant?: (text: string) => void;
  onResult?: (result: {
    output: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    isError: boolean;
  }) => void;
}

function handleSDKMessage(message: SDKMessage, callbacks: SDKCallbacks): void {
  switch (message.type) {
    case "system":
      if (message.subtype === "init" && callbacks.onInit) {
        callbacks.onInit((message as Record<string, unknown>).model as string ?? "unknown");
      }
      break;

    case "assistant":
      if (callbacks.onAssistant) {
        for (const block of message.message.content) {
          if (block.type === "text") {
            callbacks.onAssistant(block.text);
          }
        }
      }
      break;

    case "result":
      if (message.subtype === "success" && callbacks.onResult) {
        let inputTokens = 0;
        let outputTokens = 0;
        if ("modelUsage" in message) {
          for (const [, usage] of Object.entries(
            message.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number }>,
          )) {
            inputTokens += usage.inputTokens ?? 0;
            outputTokens += usage.outputTokens ?? 0;
          }
        }
        callbacks.onResult({
          output: message.result || "",
          cost: message.total_cost_usd,
          inputTokens,
          outputTokens,
          isError: !!(message as Record<string, unknown>).is_error,
        });
      }
      break;
  }
}
