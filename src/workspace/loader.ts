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
 * Read a file with overlay: check primary path first, fall back to secondary.
 * Used for PVC (mutable) → ConfigMap (immutable) overlay pattern.
 */
async function readWithFallback(
  primaryPath: string,
  fallbackPath: string | null,
): Promise<string | null> {
  const primary = await readOptionalFile(primaryPath);
  if (primary !== null) return primary;
  if (fallbackPath) return readOptionalFile(fallbackPath);
  return null;
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
 *
 * Supports overlay pattern:
 *   /workspace/ (PVC, mutable) overlays /workspace/config/ (ConfigMap, immutable)
 *
 * For each file, checks workspace root first (PVC), falls back to config/ subdir.
 * This lets knights modify their own TOOLS.md while SOUL.md stays immutable from ConfigMap.
 */
export async function loadWorkspace(config: KnightConfig): Promise<WorkspaceFiles> {
  const dir = config.workspaceDir;
  const configDir = join(dir, "config");

  const [soul, agents, tools, identity, memory] = await Promise.all([
    readWithFallback(join(dir, "SOUL.md"), join(configDir, "SOUL.md")),
    readWithFallback(join(dir, "AGENTS.md"), join(configDir, "AGENTS.md")),
    readWithFallback(join(dir, "TOOLS.md"), join(configDir, "TOOLS.md")),
    readWithFallback(join(dir, "IDENTITY.md"), join(configDir, "IDENTITY.md")),
    readOptionalFile(join(dir, "MEMORY.md")),
  ]);

  const recentMemory = await loadRecentMemory(dir);

  return { soul, agents, tools, identity, memory, recentMemory };
}
