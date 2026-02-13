/**
 * Web fetch tool — retrieve and extract content from URLs.
 */

export interface WebFetchParams {
  url: string;
  maxChars?: number;
}

export const webFetchToolDef = {
  name: "web_fetch",
  description: "Fetch and extract readable content from a URL. Returns markdown text.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch",
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (default 10000)",
      },
    },
    required: ["url"],
  },
};

export async function executeWebFetch(params: WebFetchParams): Promise<string> {
  const maxChars = params.maxChars ?? 10000;

  const response = await fetch(params.url, {
    headers: { "User-Agent": "Knight-Light/0.1 (AI Agent)" },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  // Basic HTML stripping (lightweight — no dependency needed)
  const cleaned = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, maxChars);
}
