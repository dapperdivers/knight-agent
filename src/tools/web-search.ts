/**
 * Web search tool — wraps SearXNG for knight web searches.
 */

export interface WebSearchParams {
  query: string;
  count?: number;
}

export const webSearchToolDef = {
  name: "web_search",
  description:
    "Search the web using SearXNG. Returns titles, URLs, and snippets.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
      count: {
        type: "number",
        description: "Number of results (default 5, max 10)",
      },
    },
    required: ["query"],
  },
};

export async function executeWebSearch(
  params: WebSearchParams,
  searxngUrl: string = "http://searxng.selfhosted.svc.cluster.local:8080",
): Promise<string> {
  const count = Math.min(params.count ?? 5, 10);
  const url = `${searxngUrl}/search?q=${encodeURIComponent(params.query)}&format=json`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SearXNG search failed: ${response.status}`);
  }

  const data = (await response.json()) as { results: Array<{ title: string; url: string; content: string }> };
  const results = data.results.slice(0, count);

  return results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content}`)
    .join("\n\n");
}
