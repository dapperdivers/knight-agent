import pino from "pino";
import { loadConfig } from "./config.js";
import { loadWorkspace, parseIdentity } from "./workspace/loader.js";
import { createServer } from "./server.js";
import { loadNatsConfig, startNatsSubscriber } from "./nats.js";

/**
 * Detect OAuth tokens in ANTHROPIC_API_KEY and move them to the correct env var.
 *
 * The Claude Agent SDK spawns Claude Code CLI, which sends ANTHROPIC_API_KEY as
 * the x-api-key header. OAuth tokens (sk-ant-oat01-*) require Bearer auth,
 * handled via CLAUDE_CODE_OAUTH_TOKEN env var.
 *
 * This runs BEFORE anything else touches the env.
 */
function fixOAuthEnv(): "oauth" | "api-key" | "none" {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && key.startsWith("sk-ant-oat01-")) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = key;
    delete process.env.ANTHROPIC_API_KEY;
    return "oauth";
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return "oauth";
  if (key) return "api-key";
  return "none";
}

async function main() {
  const authSource = fixOAuthEnv();
  const config = loadConfig();

  const logger = pino({ level: config.logLevel });

  logger.info(
    {
      workspace: config.workspaceDir,
      model: config.model ?? "(sdk-default)",
      auth: authSource,
      taskTimeoutMs: config.taskTimeoutMs,
      maxConcurrentTasks: config.maxConcurrentTasks,
    },
    "Knight Agent starting",
  );

  // Load workspace files
  const workspace = await loadWorkspace(config);
  const identity = parseIdentity(workspace.identity);
  const knightName = config.knightName ?? identity.name;

  logger.info(
    {
      knight: knightName,
      emoji: identity.emoji,
      hasSoul: !!workspace.soul,
      hasAgents: !!workspace.agents,
      hasTools: !!workspace.tools,
      hasMemory: !!workspace.memory,
      recentMemoryDays: workspace.recentMemory.length,
    },
    "Workspace loaded",
  );

  // Start HTTP server (health checks + optional webhook fallback)
  const app = createServer(config, workspace, logger);
  app.listen(config.port, () => {
    logger.info({ port: config.port, knight: knightName }, "HTTP server ready");
  });

  // Start NATS subscriber if configured
  const natsConfig = loadNatsConfig();
  if (natsConfig.subscribeTopics.length > 0) {
    try {
      const nc = await startNatsSubscriber(natsConfig, config, workspace, logger);
      logger.info(
        { knight: knightName, emoji: identity.emoji, topics: natsConfig.subscribeTopics },
        `${identity.emoji} ${knightName} listening on NATS`,
      );

      // Graceful shutdown
      const shutdown = async () => {
        logger.info("Shutting down...");
        await nc.drain();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to connect to NATS — running in HTTP-only mode",
      );
    }
  } else {
    logger.info("No NATS topics configured — running in HTTP webhook mode only");
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
