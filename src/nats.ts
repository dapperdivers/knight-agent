import {
  connect,
  type NatsConnection,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerInfo,
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
 * Supports both plain text and JSON payloads.
 */
function parseTaskMessage(data: string, subject: string): TaskRequest {
  try {
    const parsed = JSON.parse(data);
    return {
      message: parsed.message ?? parsed.task ?? data,
      metadata: {
        taskId: parsed.taskId ?? parsed.task_id ?? subject.split(".").pop(),
        domain: parsed.domain ?? subject.split(".")[2],
        replySubject: parsed.replySubject ?? parsed.reply_subject,
        knight: parsed.knight,
        skill: parsed.skill,
        skillContent: parsed.skillContent,
      },
    };
  } catch {
    // Plain text message
    return {
      message: data,
      metadata: {
        taskId: subject.split(".").pop(),
        domain: subject.split(".")[2],
      },
    };
  }
}

/**
 * Start the NATS subscriber — connects to JetStream and processes tasks.
 */
export async function startNatsSubscriber(
  natsConfig: NatsConfig,
  knightConfig: KnightConfig,
  workspace: WorkspaceFiles,
  logger: Logger,
): Promise<NatsConnection> {
  const identity = parseIdentity(workspace.identity);
  const knightName = knightConfig.knightName ?? identity.name;

  logger.info(
    { url: natsConfig.url, topics: natsConfig.subscribeTopics, knight: knightName },
    "Connecting to NATS",
  );

  const nc = await connect({
    servers: natsConfig.url,
    name: `knight-${natsConfig.agentId}`,
  });

  logger.info({ server: nc.getServer() }, "Connected to NATS");

  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();

  // Subscribe to each configured topic
  for (const topic of natsConfig.subscribeTopics) {
    await subscribeToTopic(nc, js, jsm, topic, natsConfig, knightConfig, workspace, logger);
  }

  // Handle connection events
  (async () => {
    for await (const status of nc.status()) {
      logger.info({ type: status.type, data: status.data }, "NATS status change");
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
  workspace: WorkspaceFiles,
  logger: Logger,
): Promise<void> {
  // Determine the stream name from the topic
  // fleet-a.tasks.security.> → fleet_a_tasks
  const streamName = `${natsConfig.fleetId.replace(/-/g, "_")}_tasks`;

  // Create or get a durable consumer
  const durableName = natsConfig.durableName ?? `${natsConfig.agentId}-consumer`;

  try {
    // Try to create consumer (idempotent if exists with same config)
    await jsm.consumers.add(streamName, {
      durable_name: durableName,
      filter_subject: topic,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.New,
      max_deliver: 3,
      ack_wait: 120_000_000_000, // 120s in nanoseconds — tasks can take a while
    });
    logger.info({ stream: streamName, consumer: durableName, topic }, "Consumer ready");
  } catch (error) {
    // Consumer might already exist — that's fine
    logger.debug({ error: String(error) }, "Consumer create (may already exist)");
  }

  // Pull-based consumer — fetch messages in a loop
  const consumer = await js.consumers.get(streamName, durableName);

  logger.info({ topic, consumer: durableName }, "Starting message processing loop");

  // Process messages
  (async () => {
    while (!nc.isClosed()) {
      try {
        const messages = await consumer.fetch({ max_messages: 1, expires: 30_000 });

        for await (const msg of messages) {
          const data = sc.decode(msg.data);
          const subject = msg.subject;

          logger.info(
            { subject, size: data.length, seq: msg.seq },
            "Task received via NATS",
          );

          try {
            // Reload workspace for fresh memory
            const freshWorkspace = await loadWorkspace(knightConfig);
            const task = parseTaskMessage(data, subject);

            // Execute the task
            const result = await executeTask(task, knightConfig, freshWorkspace, logger);

            // Publish result back
            const resultSubject =
              task.metadata?.replySubject ??
              `${natsConfig.fleetId}.results.${task.metadata?.taskId ?? "unknown"}`;

            const resultPayload = JSON.stringify({
              taskId: task.metadata?.taskId,
              knight: natsConfig.agentId,
              success: result.success,
              output: result.output,
              cost: result.cost,
              tokens: result.tokens,
              durationMs: result.durationMs,
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
            logger.error({ subject, error: errMsg }, "Task execution failed");

            // Publish error result
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
                  output: `Error: ${errMsg}`,
                }),
              ),
            );

            // NAK for retry (with delay)
            msg.nak(10_000); // 10s retry delay
          }
        }
      } catch (error) {
        // Fetch timeout or transient error — just retry
        if (!nc.isClosed()) {
          logger.debug({ error: String(error) }, "Fetch cycle (retrying)");
        }
      }
    }
  })();
}

/**
 * Publish a message to NATS (for ad-hoc publishing outside task flow).
 */
export async function publishToNats(
  nc: NatsConnection,
  subject: string,
  data: string,
): Promise<void> {
  nc.publish(subject, sc.encode(data));
}
