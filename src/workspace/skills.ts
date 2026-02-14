import { readFile, readdir, access } from "fs/promises";
import { join } from "path";

/**
 * Agent Skills loader — discovers skills following the agentskills.io spec.
 *
 * Skills are folders containing a SKILL.md with YAML frontmatter:
 *   ---
 *   name: skill-name
 *   description: What this skill does and when to use it.
 *   ---
 *   [Markdown instructions]
 *
 * Progressive disclosure:
 * - At startup: only name + description loaded (~100 tokens per skill)
 * - On activation: full SKILL.md content loaded into context
 */

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  /** Path to the skill directory */
  path: string;
}

export interface SkillFull extends SkillMeta {
  /** Full markdown body (instructions) */
  instructions: string;
  /** Available script files */
  scripts: string[];
  /** Available reference files */
  references: string[];
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Lightweight parser — no dependency needed for simple key: value pairs.
 */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return { meta: {}, body: content };
  }

  const meta: Record<string, string> = {};
  for (const line of fmMatch[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      meta[key] = value;
    }
  }

  return { meta, body: fmMatch[2] };
}

/**
 * Discover all skills in the skills directory.
 * Returns lightweight metadata only (progressive disclosure layer 1).
 */
export async function discoverSkills(skillsDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  await scanDirectory(skillsDir, skills, 0);
  return skills;
}

/**
 * Recursively scan for skills up to a max depth.
 * Stops descending into a directory if it contains a SKILL.md (it's a skill, not a category).
 */
async function scanDirectory(dir: string, skills: SkillMeta[], depth: number): Promise<void> {
  if (depth > 5) return; // Safety: don't recurse forever

  try {
    await access(dir);
  } catch {
    return;
  }

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Follow symlinks (git-sync creates worktree symlinks)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue; // Skip .git, .worktrees, etc.

    const entryPath = join(dir, entry.name);
    const skillMdPath = join(entryPath, "SKILL.md");

    try {
      await access(skillMdPath);
      const content = await readFile(skillMdPath, "utf-8");
      const { meta } = parseFrontmatter(content);

      if (meta.name && meta.description) {
        skills.push({
          name: meta.name,
          description: meta.description,
          license: meta.license,
          compatibility: meta.compatibility,
          allowedTools: meta["allowed-tools"]?.split(" ").filter(Boolean),
          path: entryPath,
        });
      }
      // Don't recurse into skill directories
    } catch {
      // No SKILL.md here — recurse deeper (it's a category directory)
      await scanDirectory(entryPath, skills, depth + 1);
    }
  }
}

/**
 * Load full skill content (progressive disclosure layer 2).
 * Called when the agent activates a skill.
 */
export async function loadSkill(skillPath: string): Promise<SkillFull | null> {
  const skillMdPath = join(skillPath, "SKILL.md");

  try {
    const content = await readFile(skillMdPath, "utf-8");
    const { meta, body } = parseFrontmatter(content);

    // Discover scripts
    const scripts: string[] = [];
    try {
      const scriptEntries = await readdir(join(skillPath, "scripts"));
      scripts.push(...scriptEntries);
    } catch { /* no scripts dir */ }

    // Discover references
    const references: string[] = [];
    try {
      const refEntries = await readdir(join(skillPath, "references"));
      references.push(...refEntries);
    } catch { /* no references dir */ }

    return {
      name: meta.name ?? "unknown",
      description: meta.description ?? "",
      license: meta.license,
      compatibility: meta.compatibility,
      allowedTools: meta["allowed-tools"]?.split(" ").filter(Boolean),
      path: skillPath,
      instructions: body,
      scripts,
      references,
    };
  } catch {
    return null;
  }
}

/**
 * Build the skill catalog string for system prompt injection.
 * Only includes name + description (progressive disclosure).
 */
export function buildSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";

  const entries = skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");

  return `<available_skills>
${entries}
</available_skills>

When a task matches a skill, load it by reading the SKILL.md file at the skill's path. Apply its instructions to the task.`;
}
