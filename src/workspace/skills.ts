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

  try {
    await access(skillsDir);
  } catch {
    return skills; // No skills directory
  }

  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    // Follow symlinks (skill-linker creates symlinks from arsenal repo)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;

    const skillPath = join(skillsDir, entry.name);
    const skillMdPath = join(skillPath, "SKILL.md");

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
          path: skillPath,
        });
      }
    } catch {
      // Skip directories without valid SKILL.md
    }
  }

  return skills;
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
