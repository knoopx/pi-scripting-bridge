/**
 * Shared skill-file parsing primitives: YAML frontmatter extraction and
 * `command` script resolution. Tool and agent skills share the frontmatter
 * shape; tool/agent/hook skills all resolve `command` with the same
 * convention (absolute as-is, relative against the skill file's directory).
 */
import { access, constants, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/** Result of reading a skill file: its raw content plus parsed frontmatter. */
export type ParsedSkillFile =
  | { ok: true; content: string; data: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Read a skill .md file, extract its YAML frontmatter, and parse it into an
 * object. Every failure mode yields `{ error }`; a non-object document is
 * `invalid YAML frontmatter`.
 */
export async function readSkillFile(
  mdPath: string,
): Promise<ParsedSkillFile> {
  let content: string;
  try {
    content = await readFile(mdPath, "utf-8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const frontmatter = extractYamlFrontmatter(content);
  if (frontmatter === undefined) {
    return { ok: false, error: "no YAML frontmatter" };
  }

  let data: unknown;
  try {
    data = parse(frontmatter.yaml);
  } catch (err) {
    return {
      ok: false,
      error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "invalid YAML frontmatter" };
  }

  return { ok: true, content, data: data as Record<string, unknown> };
}

/**
 * Extract the raw YAML text between the first pair of `---` delimiters.
 */
function extractYamlFrontmatter(content: string): { yaml: string } | undefined {
  const firstDash = content.indexOf("---");
  if (firstDash === -1) {
    return undefined;
  }

  const secondDash = content.indexOf("---", firstDash + 3);
  if (secondDash === -1) {
    return undefined;
  }

  return { yaml: content.slice(firstDash + 3, secondDash).trim() };
}

export type ResolvedScript =
  | { ok: true; scriptPath: string; args: string[] }
  | { ok: false; error: string };

/**
 * Validate a skill's `command` frontmatter value and resolve it to an
 * executable file path plus trailing argument tokens. `command` is a single
 * shell-style string: the first whitespace-delimited token is the script
 * path (absolute, or relative against the skill file's own directory — never
 * the process cwd) and any remaining tokens are forwarded to the script as
 * positional arguments (e.g. `command: ./spawn-agent.nu career-manager`
 * spawns the script with argv `["career-manager"]`).
 */
export async function resolveScriptCommand(
  mdPath: string,
  command: unknown,
): Promise<ResolvedScript> {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, error: "missing command" };
  }

  const tokens = command.trim().split(/\s+/);
  const rawPath = tokens[0];
  const args = tokens.slice(1);

  const scriptPath = isAbsolute(rawPath)
    ? rawPath
    : resolve(dirname(mdPath), rawPath);
  try {
    const st = await stat(scriptPath);
    if (!st.isFile()) {
      return { ok: false, error: `command is not a file: ${scriptPath}` };
    }
  } catch {
    return { ok: false, error: `command does not exist: ${scriptPath}` };
  }
  if (!(await isExecutable(scriptPath))) {
    return { ok: false, error: `command is not executable: ${scriptPath}` };
  }

  return { ok: true, scriptPath, args };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a default tool name from the skill file path: the file stem with
 * spaces mapped to underscores, lowercased.
 */
export function deriveName(mdPath: string): string {
  return basename(mdPath)
    .replace(/\.md$/, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
}
