import express from "express";
import type { KnightConfig } from "./config.js";
import type { WorkspaceFiles } from "./workspace/loader.js";
import { parseIdentity, loadWorkspace } from "./workspace/loader.js";
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

  // Task stats
  let activeTasks = 0;
  let totalTasks = 0;
  let lastTaskTime: Date | null = null;
  let totalCost = 0;

  /**
   * POST /hooks/agent — Receive tasks via HTTP webhook.
   * Returns 202 immediately, executes async.
   */
  app.post("/hooks/agent", async (req, res) => {
    const body = req.body as TaskRequest;

    if (!body.message) {
      res.status(400).json({ error: "Missing 'message' field" });
      return;
    }

    if (activeTasks >= config.maxConcurrentTasks) {
      res.status(503).json({ error: "Too many active tasks", activeTasks });
      return;
    }

    const taskId = body.metadata?.taskId ?? `task-${Date.now()}`;
    logger.info({ taskId, domain: body.metadata?.domain }, "Task received via HTTP");

    res.status(202).json({
      accepted: true,
      taskId,
      knight: knightName,
    });

    // Execute in background
    activeTasks++;
    totalTasks++;
    try {
      workspace = await loadWorkspace(config);
      const result = await executeTask(body, config, workspace, logger);
      totalCost += result.cost ?? 0;
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

  /** GET /healthz — Liveness probe */
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", knight: knightName });
  });

  /** GET /readyz — Readiness probe */
  app.get("/readyz", (_req, res) => {
    if (activeTasks >= config.maxConcurrentTasks) {
      res.status(503).json({ status: "busy", activeTasks });
      return;
    }
    res.status(200).json({ status: "ready", activeTasks });
  });

  /** GET /info — Knight identity and status */
  app.get("/info", (_req, res) => {
    res.json({
      knight: knightName,
      emoji: identity.emoji,
      description: identity.description,
      model: config.model ?? "(sdk-default)",
      auth: config.authMethod,
      workspace: config.workspaceDir,
      stats: {
        activeTasks,
        totalTasks,
        totalCost: Math.round(totalCost * 10000) / 10000,
        lastTaskTime: lastTaskTime?.toISOString() ?? null,
        uptime: Math.floor(process.uptime()),
      },
    });
  });

  return app;
}
