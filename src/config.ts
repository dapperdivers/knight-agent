import { existsSync } from "fs";

/**
 * Knight Agent configuration — loaded from environment variables.
 */
export interface KnightConfig {
  /** Workspace directory containing SOUL.md, AGENTS.md, etc. */
  workspaceDir: string;
  /** HTTP server port */
  port: number;
  /** Default model for agent tasks */
  model: string;
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
}

export function loadConfig(): KnightConfig {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const claudeAuthDir = process.env.CLAUDE_AUTH_DIR ?? `${process.env.HOME}/.claude`;
  const hasOAuth = hasOAuthToken || !!process.env.CLAUDE_AUTH_DIR || existsSync(`${claudeAuthDir}/.credentials.json`);

  return {
    workspaceDir: process.env.WORKSPACE_DIR ?? "/workspace",
    port: parseInt(process.env.PORT ?? "18789", 10),
    model: process.env.MODEL ?? "claude-sonnet-4-5-20250514",
    maxTokens: parseInt(process.env.MAX_TOKENS ?? "16384", 10),
    knightName: process.env.KNIGHT_NAME,
    logLevel: process.env.LOG_LEVEL ?? "info",
    authMethod: hasApiKey ? "api-key" : "oauth",
    claudeAuthDir,
  };
}
