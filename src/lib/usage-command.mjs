// A recipe/source lists names that could replace its local usage command. Never read their contents; an
// unreadable path is not evidence of absence. The menu guard handles shadows outside the documented locations.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./runtime.mjs";
export const usageCommandShadowed = (paths = []) => paths.some((path) => {
  try { lstatSync(path); return true; } catch (e) { return e?.code !== "ENOENT"; }
});
// Fixed, versioned files in routr's own state, outside the empty work folder. Never follow an existing link or
// overwrite unexpected contents. This avoids typed JSON quoting, especially native argument passing in PS 5.1.
export function usageStateFile(name, contents) {
  const dir = join(STATE_DIR(), "usage-settings"), file = join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { writeFileSync(file, contents, { flag: "wx", mode: 0o600 }); }
  catch (e) { if (e?.code !== "EEXIST") throw e; }
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || readFileSync(file, "utf8") !== contents) throw new Error("usage settings unavailable");
  return file;
}
