import { readFile, readdir, access } from "fs/promises";
import { join } from "path";
import type { KnightConfig } from "../config.js";

/**
 * Workspace files loaded from the knight's mounted volume.
 */
export interface WorkspaceFiles {
  soul: string | null;
  agents: string | null;
  tools: string | null;
  identity: string | null;
  memory: string | null;
  recentMemory: string[];
}

/**
 * Parsed identity from IDENTITY.md
 */
export interface KnightIdentity {
  name: string;
  emoji: string;
  description: string;
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    await access(path);
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load recent daily memory files (today + yesterday).
 */
async function loadRecentMemory(workspaceDir: string): Promise<string[]> {
  const memoryDir = join(workspaceDir, "memory");
  const entries: string[] = [];

  try {
    const files = await readdir(memoryDir);
    // Filter for YYYY-MM-DD.md pattern, sort descending
    const dailyFiles = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 2); // today + yesterday

    for (const file of dailyFiles) {
      const content = await readFile(join(memoryDir, file), "utf-8");
      entries.push(`## ${file.replace(".md", "")}\n${content}`);
    }
  } catch {
    // No memory directory yet — that's fine
  }

  return entries;
}

/**
 * Parse IDENTITY.md into structured identity data.
 */
export function parseIdentity(content: string | null): KnightIdentity {
  if (!content) {
    return { name: "Knight", emoji: "⚔️", description: "A knight of the round table" };
  }

  const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
  const emojiMatch = content.match(/\*\*Emoji:\*\*\s*(.+)/);
  const descMatch = content.match(/\*\*(?:Creature|Description|Vibe):\*\*\s*(.+)/);

  return {
    name: nameMatch?.[1]?.trim() ?? "Knight",
    emoji: emojiMatch?.[1]?.trim() ?? "⚔️",
    description: descMatch?.[1]?.trim() ?? "A knight of the round table",
  };
}

/**
 * Load all workspace files for a knight.
 */
export async function loadWorkspace(config: KnightConfig): Promise<WorkspaceFiles> {
  const dir = config.workspaceDir;

  const [soul, agents, tools, identity, memory] = await Promise.all([
    readOptionalFile(join(dir, "SOUL.md")),
    readOptionalFile(join(dir, "AGENTS.md")),
    readOptionalFile(join(dir, "TOOLS.md")),
    readOptionalFile(join(dir, "IDENTITY.md")),
    readOptionalFile(join(dir, "MEMORY.md")),
  ]);

  const recentMemory = await loadRecentMemory(dir);

  return { soul, agents, tools, identity, memory, recentMemory };
}
