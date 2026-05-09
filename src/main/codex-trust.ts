// Read/write project trust entries in ~/.codex/config.toml.
//
// Codex gates project-scoped layers (.codex/config.toml, hooks, .rules,
// .codex/agents/) behind a per-path trust flag stored in the user's
// ~/.codex/config.toml as:
//
//   [projects."/abs/path/to/project"]
//   trust_level = "trusted"
//
// Without this entry, `codex exec --cd /abs/path/to/project` skips every
// project-scoped layer. Codex's interactive TUI prompts the user once per
// project to set this; the headless `exec` form has no such prompt, so
// when the desktop app spawns a Codex agent we offer to write this entry
// after explicit user consent.
//
// Scope is intentionally narrow: we read+match on `[projects."<p>"]` (or
// the literal-string variant `[projects.'<p>']`) and append a new section
// at EOF when needed. We never modify or delete existing entries — if a
// project is already explicitly marked `untrusted`, we surface an error
// and ask the user to edit manually rather than silently flipping it.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG_DIR = path.join(os.homedir(), ".codex");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.toml");

export type TrustStatus = "trusted" | "untrusted" | "unset";

export interface TrustResult {
  ok: boolean;
  /** Resulting status after the operation (or current status on no-op). */
  status: TrustStatus;
  /** Set when ok=false. */
  error?: string;
}

function tomlBasicString(s: string): string {
  // Encode as a TOML basic string ("…") — escape backslashes and quotes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function decodeBasicString(escaped: string): string {
  return escaped.replace(/\\(.)/g, "$1");
}

function parseProjectHeader(line: string): string | null {
  // Match `[projects."path"]` or `[projects.'path']` (with surrounding ws).
  // Bare keys aren't allowed for filesystem paths because of slashes.
  const basic = line.match(/^\s*\[projects\.\"((?:[^\"\\]|\\.)*)\"\]\s*(?:#.*)?$/);
  if (basic) return decodeBasicString(basic[1]);
  const literal = line.match(/^\s*\[projects\.'([^']*)'\]\s*(?:#.*)?$/);
  if (literal) return literal[1];
  return null;
}

function isAnySectionHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

export async function getProjectTrust(projectPath: string): Promise<TrustStatus> {
  if (!existsSync(CONFIG_PATH)) return "unset";
  let text: string;
  try {
    text = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch {
    return "unset";
  }
  const lines = text.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    // Strip line comments before testing — but keep raw for header parsing
    // (header parser also tolerates trailing comments).
    const headerPath = parseProjectHeader(raw);
    if (headerPath !== null) {
      inSection = headerPath === projectPath;
      continue;
    }
    if (isAnySectionHeader(raw)) {
      // A different section started; stop scanning the previous one.
      inSection = false;
      continue;
    }
    if (inSection) {
      const m = raw.match(/^\s*trust_level\s*=\s*["']([^"']*)["']/);
      if (m) {
        return m[1] === "trusted" ? "trusted" : "untrusted";
      }
    }
  }
  return "unset";
}

export async function trustProject(projectPath: string): Promise<TrustResult> {
  const current = await getProjectTrust(projectPath);
  if (current === "trusted") return { ok: true, status: "trusted" };
  if (current === "untrusted") {
    return {
      ok: false,
      status: "untrusted",
      error:
        "This project is explicitly marked 'untrusted' in ~/.codex/config.toml. " +
        "Edit that file manually to flip it — coagent won't override an explicit choice.",
    };
  }
  // current === "unset" — append a new trusted entry.
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  let prior = "";
  if (existsSync(CONFIG_PATH)) {
    try {
      prior = await fs.readFile(CONFIG_PATH, "utf-8");
    } catch (e) {
      return {
        ok: false,
        status: "unset",
        error: `failed to read ~/.codex/config.toml: ${(e as Error).message}`,
      };
    }
  }
  const sep = prior.length === 0 || prior.endsWith("\n") ? "" : "\n";
  const block =
    `${sep}\n# Added by coagent — allows project-scoped .codex/config.toml,\n` +
    `# hooks, and project subagents to load for codex exec runs.\n` +
    `[projects.${tomlBasicString(projectPath)}]\n` +
    `trust_level = "trusted"\n`;
  try {
    await fs.writeFile(CONFIG_PATH, prior + block, "utf-8");
  } catch (e) {
    return {
      ok: false,
      status: "unset",
      error: `failed to write ~/.codex/config.toml: ${(e as Error).message}`,
    };
  }
  return { ok: true, status: "trusted" };
}
