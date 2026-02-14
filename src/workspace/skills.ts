import { readFile, readdir, access, stat } from "fs/promises";
import { join } from "path";

/**
 * Agent Skills loader — discovers skills following the agentskills.io spec.
 *
 * Recursively walks skill directories to find SKILL.md files at any depth.
 * Handles symlinks (git-sync worktrees), nested categories, and dotfiles.
 *
 * Supports KNIGHT_SKILLS env var for per-knight skill filtering:
 *   KNIGHT_SKILLS="shared security" → only loads skills under shared/ and security/ categories
 *   If unset, loads ALL discovered skills.
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
  /** Category path (e.g., "shared", "security/opencti-intel") */
  category?: string;
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
 * Discover all skills by recursively walking the directory tree.
 * Follows symlinks, skips dotfiles/dirs, stops recursing into skill dirs.
 *
 * If KNIGHT_SKILLS env var is set (space-separated category names),
 * only skills whose path includes a matching category are returned.
 * The "shared" category is always included if KNIGHT_SKILLS is set.
 */
export async function discoverSkills(skillsDir: string): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];

  try {
    await access(skillsDir);
  } catch {
    return skills;
  }

  await walkForSkills(skillsDir, skillsDir, skills, 0);

  // Apply KNIGHT_SKILLS filter if set
  const knightSkills = process.env.KNIGHT_SKILLS?.trim();
  if (knightSkills) {
    const allowed = new Set(knightSkills.split(/\s+/));
    // Always include "shared"
    allowed.add("shared");

    return skills.filter((skill) => {
      // Check if the skill path contains any allowed category
      const relPath = skill.path.slice(skillsDir.length + 1);
      return [...allowed].some((cat) => relPath.includes(`/${cat}/`) || relPath.startsWith(`${cat}/`));
    });
  }

  return skills;
}

/**
 * Recursively walk directories looking for SKILL.md files.
 * Max depth 8 handles: git-sync worktree → repo → category → skill (4 levels typical).
 */
async function walkForSkills(
  rootDir: string,
  dir: string,
  skills: SkillMeta[],
  depth: number,
): Promise<void> {
  if (depth > 8) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip dotfiles/dirs (.git, .worktrees, .github, etc.)
    if (entry.name.startsWith(".")) continue;

    const entryPath = join(dir, entry.name);

    // Resolve symlinks to check if they point to directories
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        const stats = await stat(entryPath); // stat follows symlinks
        isDir = stats.isDirectory();
      } catch {
        continue; // Broken symlink
      }
    }

    if (!isDir) continue;

    // Check if this directory contains a SKILL.md
    const skillMdPath = join(entryPath, "SKILL.md");
    try {
      await access(skillMdPath);
      const content = await readFile(skillMdPath, "utf-8");
      const { meta } = parseFrontmatter(content);

      if (meta.name && meta.description) {
        // Derive category from relative path
        const relPath = entryPath.slice(rootDir.length + 1);

        skills.push({
          name: meta.name,
          description: meta.description,
          license: meta.license,
          compatibility: meta.compatibility,
          allowedTools: meta["allowed-tools"]?.split(" ").filter(Boolean),
          path: entryPath,
          category: relPath,
        });
      }
      // Don't recurse into skill directories — they're leaves
    } catch {
      // No SKILL.md here — it's a category dir, recurse deeper
      await walkForSkills(rootDir, entryPath, skills, depth + 1);
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
