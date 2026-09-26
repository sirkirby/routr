// Preloaded before every test file (bunfig.toml). Tests call no harness and touch nothing of the maintainer's.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A stub herdr goes first on PATH, so a test that reaches past its fake is refused instead of driving the maintainer's
// own herdr (a wrong argument once opened four real Cursor panes there, 2026-09-25). Windows looks a command up by
// PATHEXT and skips the extensionless stub, so there the folders holding herdr leave PATH.
const withoutHerdr = (path) => process.platform !== "win32" ? path
  : path.split(delimiter).filter((d) => !["herdr.exe", "herdr.cmd", "herdr.bat"].some((f) => existsSync(join(d, f)))).join(delimiter);
process.env.PATH = join(import.meta.dir, "fixtures", "no-herdr") + delimiter + withoutHerdr(process.env.PATH ?? "");
delete process.env.HERDR_ENV;
process.env.ROUTR_NO_REFRESH = "1"; // no detached Cursor refresh, and nothing written to the real cache

// Every folder a test makes is inside one scratch folder, removed when the run ends however a test ended, and nothing
// is written into test/. Every CLI a test spawns sees a scratch home, never the maintainer's own (its config, ledger,
// cache). A spawn that could start a harness also empties PATH: a logged-out harness opens a browser to sign in.
const scratch = mkdtempSync(join(tmpdir(), "routr-test-"));
process.env.ROUTR_TEST_SCRATCH = scratch;
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(scratch, "home-"));
