// A recipe/source lists names that could replace its local usage command. Never read their contents; an
// unreadable path is not evidence of absence. The menu guard handles shadows outside the documented locations.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { STATE_DIR } from "./runtime.mjs";
export const usageCommandShadowed = (paths = []) => paths.some((path) => {
  try { lstatSync(path); return true; } catch (e) { return e?.code !== "ENOENT"; }
});
// Content-addressed files in routr's own state, outside the empty work folder. Never follow an existing link or
// overwrite unexpected contents. This avoids typed JSON quoting, especially native argument passing in PS 5.1.
export function usageStateFile(ext, contents) {
  try {
    const dir = join(STATE_DIR(), "usage-settings"), file = join(dir, `${createHash("sha256").update(contents).digest("hex")}.${ext}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error();
    try { writeFileSync(file, contents, { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e?.code !== "EEXIST") throw e; }
    const st = lstatSync(file);
    if (!st.isFile() || readFileSync(file, "utf8") !== contents) throw new Error();
    return file;
  } catch { throw Object.assign(new Error(), { usageCode: "private_folder" }); }
}
