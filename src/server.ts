import express from "express";
import type { KnightConfig } from "./config.js";
import type { WorkspaceFiles } from "./workspace/loader.js";
import { parseIdentity } from "./workspace/loader.js";
import { loadWorkspace } from "./workspace/loader.js";
import { executeTask, type TaskRequest } from "./agent.js";
import type { Logger } from "pino";

/**
 * Create the Express HTTP server for the knight runtime.
 */
export function createServer(
  config: KnightConfig,
  initialWorkspace: WorkspaceFiles,
  logger: Logger,
) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  let workspace = initialWorkspace;
  const identity = parseIdentity(workspace.identity);
  const knightName = config.knightName ?? identity.name;

  // Track active tasks for health reporting
  let activeTasks = 0;
  let totalTasks = 0;
  let lastTaskTime: Date | null = null;

  /**
   * POST /hooks/agent — Receive tasks from nats-bridge.
   *
   * Same contract as OpenClaw's webhook: accepts { message, metadata? }
   * Returns 202 immediately, executes async.
   */
  app.post("/hooks/agent", async (req, res) => {
    const body = req.body as TaskRequest;

    if (!body.message) {
      res.status(400).json({ error: "Missing 'message' field" });
      return;
    }

    const taskId = body.metadata?.taskId ?? `task-${Date.now()}`;
    logger.info({ taskId, domain: body.metadata?.domain }, "Task received");

    // Return 202 immediately — task runs async
    res.status(202).json({
      accepted: true,
      taskId,
      knight: knightName,
    });

    // Execute in background
    activeTasks++;
    totalTasks++;
    try {
      // Reload workspace files (picks up memory changes)
      workspace = await loadWorkspace(config);

      await executeTask(body, config, workspace, logger);
    } catch (error) {
      logger.error(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        "Unhandled task error",
      );
    } finally {
      activeTasks--;
      lastTaskTime = new Date();
    }
  });

  /**
   * GET /healthz — Liveness probe.
   */
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", knight: knightName });
  });

  /**
   * GET /readyz — Readiness probe.
   */
  app.get("/readyz", (_req, res) => {
    // Ready if not overloaded
    if (activeTasks > 3) {
      res.status(503).json({ status: "busy", activeTasks });
      return;
    }
    res.status(200).json({ status: "ready", activeTasks });
  });

  /**
   * GET /info — Knight identity and status.
   */
  app.get("/info", (_req, res) => {
    res.json({
      knight: knightName,
      emoji: identity.emoji,
      description: identity.description,
      model: config.model,
      auth: config.authMethod,
      workspace: config.workspaceDir,
      stats: {
        activeTasks,
        totalTasks,
        lastTaskTime: lastTaskTime?.toISOString() ?? null,
      },
    });
  });

  return app;
}
