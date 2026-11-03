// Real CLI → readSnapshot → spawnSelf → CLI --background with its real adopted lock. All harnesses are native fixtures.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnv, noPanelText, scratch, SCRIPT } from "./helpers.mjs";

const root = scratch("detached-fixtures"), binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture");
const built = Bun.spawnSync([process.execPath, "build", join(import.meta.dir, "fixtures/detached-usage.mjs"), "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", binary]);
if (built.exitCode !== 0) throw new Error("fixture compilation failed");
for (const name of ["claude", "cursor-agent", "kiro-cli", "herdr"]) {
  const path = join(root, name + (process.platform === "win32" ? ".exe" : ""));
  try { linkSync(binary, path); } catch { copyFileSync(binary, path); }
}

for (const seat of ["claude", "cursor", "kiro"]) test(`real detached ${seat} usage preserves the starter's env and publishes`, async () => {
    const home = scratch(`detached-${seat}`), cwd = scratch("dotenv-project"), calls = join(home, "calls.jsonl");
    mkdirSync(join(home, ".config/routr"), { recursive: true }); mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor/cli-config.json"), "{}");
    writeFileSync(join(home, ".config/routr/config.json"), JSON.stringify({ subscriptions: { [seat]: { use: "normal", reserve: 0.2, hardest_work: "strong" } } }));
    writeFileSync(join(cwd, ".env"), "ROUTR_DETACHED_DOTENV=1\n");
    const env = cliEnv(home, { PATH: root, ROUTR_NO_REFRESH: "0", ROUTR_NO_UPDATE: "1", ROUTR_OTEL: "0", ROUTR_TELEMETRY: "0",
      CLAUDE_CONFIG_DIR: join(home, "claude"), ROUTR_FIXTURE_CALLS: calls, ROUTR_FIXTURE_SEAT: seat,
      ROUTR_FIXTURE_SCREEN: join(home, "screen.json"), ROUTR_FIXTURE_PANEL: join(import.meta.dir, "fixtures/admin-limits/claude-panel-no-limit.txt") });
    delete env.ROUTR_DETACHED_DOTENV;
    const run = () => {
      const r = Bun.spawnSync([process.execPath, "--no-env-file", SCRIPT, "usage", "--json"], { cwd, env });
      expect(r.exitCode).toBe(0); noPanelText(r.stdout.toString()); noPanelText(r.stderr.toString()); return JSON.parse(r.stdout.toString());
    };
    expect(run().subscriptions.ranked[0].note).toContain("being taken in the background");
    const file = join(home, ".cache/routr", seat === "claude" ? "claude-panel-usage.json" : `${seat}-usage.json`);
    let snap;
    for (let i = 0; i < 400; i++) {
      try { snap = JSON.parse(readFileSync(file, "utf8")); } catch {}
      if (snap?.tried && !existsSync(`${file}.lock`)) break;
      await Bun.sleep(50);
    }
    const seen = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
    expect({ seat, dotenv: seen.some((c) => c.dirty), keys: Object.keys(snap ?? {}).sort() }).toEqual({ seat, dotenv: false, keys: ["by", "reading", "tried", "ts"] });
    expect(snap?.failure).toBeUndefined(); expect(snap?.reading).toBeDefined();
    expect(existsSync(`${file}.lock`)).toBe(false);
    const row = run().subscriptions.ranked[0];
    if (seat === "claude") expect(row.note).toBe("Claude's panel shows no spend limit: still metered");
    else expect(row.usage).toBe("live");
}, 60000);
