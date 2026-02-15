import { existsSync } from "fs";

/**
 * Knight Agent configuration — loaded from environment variables.
 */
export interface KnightConfig {
  /** Workspace directory containing SOUL.md, AGENTS.md, etc. */
  workspaceDir: string;
  /** Directory containing baked-in default files (AGENTS.md, etc.) */
  defaultsDir: string;
  /** Vault mount path (Derek's Second Brain, optional) */
  vaultPath: string;
  /** HTTP server port */
  port: number;
  /** Default model for agent tasks (undefined = SDK default) */
  model?: string;
  /** Max output tokens */
  maxTokens: number;
  /** Knight name override (read from IDENTITY.md if not set) */
  knightName?: string;
  /** Log level */
  logLevel: string;
  /** Auth method: 'api-key' or 'oauth' */
  authMethod: "api-key" | "oauth";
  /** Path to OAuth credential directory */
  claudeAuthDir: string;
  /** Task timeout in milliseconds */
  taskTimeoutMs: number;
  /** Max concurrent tasks */
  maxConcurrentTasks: number;
}

export function loadConfig(): KnightConfig {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const claudeAuthDir = process.env.CLAUDE_AUTH_DIR ?? `${process.env.HOME}/.claude`;
  const hasOAuth =
    hasOAuthToken ||
    !!process.env.CLAUDE_AUTH_DIR ||
    existsSync(`${claudeAuthDir}/.credentials.json`);

  // MODEL env var is optional — omitting it lets the SDK use its own default
  const model = process.env.MODEL || undefined;

  return {
    workspaceDir: process.env.WORKSPACE_DIR ?? "/workspace",
    defaultsDir: process.env.DEFAULTS_DIR ?? "/app/defaults",
    vaultPath: process.env.VAULT_PATH ?? "/vault",
    port: parseInt(process.env.PORT ?? "18789", 10),
    model,
    maxTokens: parseInt(process.env.MAX_TOKENS ?? "16384", 10),
    knightName: process.env.KNIGHT_NAME,
    logLevel: process.env.LOG_LEVEL ?? "info",
    authMethod: hasApiKey ? "api-key" : hasOAuth ? "oauth" : "api-key",
    claudeAuthDir,
    taskTimeoutMs: parseInt(process.env.TASK_TIMEOUT_MS ?? "120000", 10),
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS ?? "1", 10),
  };
}
