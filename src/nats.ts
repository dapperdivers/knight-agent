import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
} from "nats";
import type { KnightConfig } from "./config.js";
import type { WorkspaceFiles } from "./workspace/loader.js";
import { loadWorkspace, parseIdentity } from "./workspace/loader.js";
import { executeTask, type TaskRequest } from "./agent.js";
import type { Logger } from "pino";

const sc = StringCodec();

export interface NatsConfig {
  /** NATS server URL */
  url: string;
  /** Fleet ID for topic prefix */
  fleetId: string;
  /** Agent/knight ID */
  agentId: string;
  /** Topics to subscribe to (e.g., "fleet-a.tasks.security.>") */
  subscribeTopics: string[];
  /** Durable consumer name */
  durableName?: string;
}

export function loadNatsConfig(): NatsConfig {
  return {
    url: process.env.NATS_URL ?? "nats://nats.database.svc:4222",
    fleetId: process.env.FLEET_ID ?? "fleet-a",
    agentId: process.env.AGENT_ID ?? "knight",
    subscribeTopics: (process.env.SUBSCRIBE_TOPICS ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    durableName: process.env.NATS_DURABLE_NAME,
  };
}

/**
 * Parse a NATS task message into a TaskRequest.
 *
 * Supports multiple formats:
 *   - JSON with top-level fields: { task, taskId, domain, ... }
 *   - JSON with nested metadata: { task, metadata: { taskId, domain, ... } }
 *   - Plain text (uses subject for metadata)
 */
function parseTaskMessage(data: string, subject: string): TaskRequest {
  try {
    const parsed = JSON.parse(data);

    // Extract task/message content
    const message = parsed.message ?? parsed.task ?? data;

    // Extract metadata — check both top-level and nested metadata object
    const meta = parsed.metadata ?? {};
    const taskId =
      parsed.taskId ?? parsed.task_id ?? meta.taskId ?? meta.task_id ?? subjectTail(subject);
    const domain =
      parsed.domain ?? meta.domain ?? subjectDomain(subject);

    return {
      message,
      metadata: {
        taskId,
        domain,
        replySubject: parsed.replySubject ?? parsed.reply_subject ?? meta.replySubject,
        knight: parsed.knight ?? meta.knight,
        skill: parsed.skill ?? meta.skill,
        skillContent: parsed.skillContent ?? meta.skillContent,
      },
    };
  } catch {
    // Plain text message
    return {
      message: data,
      metadata: {
        taskId: subjectTail(subject),
        domain: subjectDomain(subject),
      },
    };
  }
}

/** Extract the last segment of a NATS subject */
function subjectTail(subject: string): string {
  return subject.split(".").pop() ?? "unknown";
}

/** Extract the domain segment (3rd part) of a fleet subject */
function subjectDomain(subject: string): string {
  return subject.split(".")[2] ?? "general";
}

/**
 * Start the NATS subscriber — connects to JetStream and processes tasks.
 */
export async function startNatsSubscriber(
  natsConfig: NatsConfig,
  knightConfig: KnightConfig,
  _workspace: WorkspaceFiles,
  logger: Logger,
): Promise<NatsConnection> {
  const nc = await connect({
    servers: natsConfig.url,
    name: `knight-${natsConfig.agentId}`,
    reconnect: true,
    maxReconnectAttempts: -1, // infinite reconnect
    reconnectTimeWait: 2000,
  });

  logger.info({ server: nc.getServer() }, "Connected to NATS");

  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  // Subscribe to each configured topic
  for (const topic of natsConfig.subscribeTopics) {
    await subscribeToTopic(nc, js, jsm, topic, natsConfig, knightConfig, logger);
  }

  // Handle connection events
  (async () => {
    for await (const status of nc.status()) {
      const level = status.type === "reconnect" ? "warn" : "info";
      logger[level]({ type: status.type, data: status.data }, "NATS status change");
    }
  })();

  return nc;
}

async function subscribeToTopic(
  nc: NatsConnection,
  js: JetStreamClient,
  jsm: JetStreamManager,
  topic: string,
  natsConfig: NatsConfig,
  knightConfig: KnightConfig,
  logger: Logger,
): Promise<void> {
  // fleet-a.tasks.security.> → fleet_a_tasks
  const streamName = `${natsConfig.fleetId.replace(/-/g, "_")}_tasks`;
  const durableName = natsConfig.durableName ?? `${natsConfig.agentId}-consumer`;

  try {
    await jsm.consumers.add(streamName, {
      durable_name: durableName,
      filter_subject: topic,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      max_deliver: 3,
      ack_wait: (knightConfig.taskTimeoutMs + 30_000) * 1_000_000, // task timeout + 30s buffer, in nanoseconds
    });
    logger.info({ stream: streamName, consumer: durableName, topic }, "Consumer ready");
  } catch (error) {
    logger.debug({ error: String(error) }, "Consumer create (may already exist)");
  }

  const consumer = await js.consumers.get(streamName, durableName);
  logger.info({ topic, consumer: durableName }, "Starting message processing loop");

  // Track active tasks for concurrency control
  let activeTasks = 0;

  (async () => {
    while (!nc.isClosed()) {
      try {
        // Respect concurrency limit
        if (activeTasks >= knightConfig.maxConcurrentTasks) {
          await sleep(1000);
          continue;
        }

        const messages = await consumer.fetch({ max_messages: 1, expires: 30_000 });

        for await (const msg of messages) {
          activeTasks++;
          // Process async so we can fetch next message if concurrency allows
          processMessage(nc, msg, natsConfig, knightConfig, logger)
            .finally(() => {
              activeTasks--;
            });
        }
      } catch (error) {
        if (!nc.isClosed()) {
          logger.debug({ error: String(error) }, "Fetch cycle (retrying)");
        }
      }
    }
  })();
}

async function processMessage(
  nc: NatsConnection,
  msg: { data: Uint8Array; subject: string; seq: number; ack: () => void; nak: (delay?: number) => void },
  natsConfig: NatsConfig,
  knightConfig: KnightConfig,
  logger: Logger,
): Promise<void> {
  const data = sc.decode(msg.data);
  const subject = msg.subject;

  logger.info({ subject, size: data.length, seq: msg.seq }, "Task received via NATS");

  try {
    // Reload workspace for fresh memory each task
    const freshWorkspace = await loadWorkspace(knightConfig);
    const task = parseTaskMessage(data, subject);

    const result = await executeTask(task, knightConfig, freshWorkspace, logger);

    // Publish result
    const resultSubject =
      task.metadata?.replySubject ??
      `${natsConfig.fleetId}.results.${task.metadata?.taskId ?? "unknown"}`;

    const resultPayload = JSON.stringify({
      taskId: task.metadata?.taskId,
      knight: natsConfig.agentId,
      success: result.success,
      output: result.output,
      error: result.error,
      cost: result.cost,
      tokens: result.tokens,
      durationMs: result.durationMs,
      model: result.model,
    });

    nc.publish(resultSubject, sc.encode(resultPayload));
    logger.info(
      {
        taskId: task.metadata?.taskId,
        resultSubject,
        success: result.success,
        durationMs: result.durationMs,
      },
      "Result published to NATS",
    );

    msg.ack();
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ subject, error: errMsg }, "Task processing failed");

    // Publish error result so the caller isn't left hanging
    const task = parseTaskMessage(data, subject);
    const resultSubject =
      task.metadata?.replySubject ??
      `${natsConfig.fleetId}.results.${task.metadata?.taskId ?? "unknown"}`;

    nc.publish(
      resultSubject,
      sc.encode(
        JSON.stringify({
          taskId: task.metadata?.taskId,
          knight: natsConfig.agentId,
          success: false,
          error: errMsg,
          output: "",
        }),
      ),
    );

    // NAK for retry with delay
    msg.nak(10_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
