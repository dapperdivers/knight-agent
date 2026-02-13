/**
 * NATS respond tool — allows knights to publish results back via nats-bridge.
 *
 * This is a custom tool that wraps the nats-bridge /publish endpoint,
 * giving the agent a clean interface to return results.
 */

export interface NatsRespondParams {
  /** NATS subject to publish to */
  subject: string;
  /** Result payload (will be JSON stringified) */
  result: string;
}

/**
 * Tool definition for the Claude Agent SDK.
 * This gets registered as a custom tool the agent can call.
 */
export const natsRespondToolDef = {
  name: "nats_respond",
  description:
    "Publish a result back to the task dispatcher via NATS. " +
    "Use this to return your findings after completing a task. " +
    "The subject should match the reply subject from task metadata.",
  input_schema: {
    type: "object" as const,
    properties: {
      subject: {
        type: "string",
        description: "NATS subject to publish the result to (from task_metadata.reply_subject)",
      },
      result: {
        type: "string",
        description: "The result payload — your analysis, findings, or response",
      },
    },
    required: ["subject", "result"],
  },
};

/**
 * Execute the nats_respond tool by POSTing to nats-bridge's /publish endpoint.
 */
export async function executeNatsRespond(
  params: NatsRespondParams,
  bridgeUrl: string = "http://127.0.0.1:8080",
): Promise<string> {
  const url = `${bridgeUrl}/publish`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: params.subject,
      data: params.result,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`nats-bridge /publish failed: ${response.status} ${body}`);
  }

  return `Result published to ${params.subject}`;
}
