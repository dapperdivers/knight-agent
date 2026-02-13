import pino from "pino";
import { loadConfig } from "./config.js";
import { loadWorkspace, parseIdentity } from "./workspace/loader.js";
import { createServer } from "./server.js";

async function main() {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV !== "production"
        ? { target: "pino-pretty" }
        : undefined,
  });

  logger.info({ workspace: config.workspaceDir, model: config.model }, "Knight Light starting");

  // Load workspace files
  const workspace = await loadWorkspace(config);
  const identity = parseIdentity(workspace.identity);
  const knightName = config.knightName ?? identity.name;

  logger.info(
    {
      knight: knightName,
      emoji: identity.emoji,
      auth: config.authMethod,
      hasSoul: !!workspace.soul,
      hasAgents: !!workspace.agents,
      hasTools: !!workspace.tools,
      hasMemory: !!workspace.memory,
      recentMemoryDays: workspace.recentMemory.length,
    },
    "Workspace loaded",
  );

  // Start server
  const app = createServer(config, workspace, logger);
  app.listen(config.port, () => {
    logger.info(
      { port: config.port, knight: knightName, emoji: identity.emoji },
      `${identity.emoji} ${knightName} ready for tasks`,
    );
  });
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
