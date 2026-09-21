// Facts about this process and routr's own files that several modules need. No imports beyond node: `statusline`
// loads this on every Claude Code turn.
import { homedir } from "node:os";
import { join } from "node:path";

// A compiled release binary has no script path of its own; a source checkout runs `bun src/routr.mjs`.
export const standalone = () => !/\.m?js$/.test(process.argv[1] ?? "");

export const CACHE_DIR = () => join(homedir(), ".cache/routr");
// Written by `routr statusline` on each Claude Code turn, read by the usage reader.
export const CLAUDE_SNAPSHOT = join(homedir(), ".cache/routr/claude-usage.json");
