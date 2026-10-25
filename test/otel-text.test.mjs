import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { guided } from "../src/lib/setup-guided.mjs";
import { COMMANDS, formatCommandHelp } from "../src/lib/help.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const schema = "https://github.com/sirkirby/routr/blob/main/docs/opentelemetry.md";

for (const existing of [false, true]) test(`guided export consent describes current signals before asking (${existing ? "enabled exporter" : "first setup"})`, async () => {
  const lines = [], menu = ["otel", "done"];
  const ui = { line: (s) => lines.push(s), note: () => {}, style: { dim: (s) => s }, glyphs: { arrow: "→" }, search: async () => "",
    multiselect: async (q) => q.initial, select: async (q) => q.message === "What would you like to do?" ? menu.shift() : q.initial,
    confirm: async (q) => {
      if (q.message === "Export OpenTelemetry to your own endpoint?") {
        const notice = lines.join("\n");
        for (const text of ["traces", "logs", "headroom gauge", "repository names, relative paths and ids", "never briefs, reports or secrets", schema]) expect(notice).toContain(text);
        expect(notice).not.toMatch(/No spans|Later signals/);
        expect(q.initial).toBe(false);
      }
      return false;
    } };
  await guided({ ui, r: { harnesses: { cursor: { installed: true, signed_in: true } } },
    config: existing ? { subscriptions: { cursor: { enabled: true } }, otel: { endpoint: "https://example.test", consent: "a".repeat(32) } } : null, efforts: async () => null });
  expect(lines.join("\n")).toContain(schema);
});

test("setup help and guide describe the current export signals", () => {
  for (const text of [formatCommandHelp(COMMANDS.setup), read("skills/routr/references/setup.md")]) {
    expect(text).not.toMatch(/No (?:spans|signals).*yet|later signals/i);
    for (const signal of ["traces", "logs", "headroom gauge"]) expect(text).toContain(signal);
  }
});

test("custom export config documentation names only commands accepting --config", () => {
  const doc = read("docs/opentelemetry.md");
  expect(COMMANDS.launch.flags.some((f) => f.name === "--config")).toBe(false);
  expect(doc).toContain("For commands that accept `--config`");
  expect(doc).toContain("`launch` does not accept `--config`");
  expect(doc).not.toContain("A launch using another config");
});

test("carrier and read-only descriptions include the export exception", () => {
  expect(read("CHANGELOG.md")).toMatch(/With export off, workers[\s\S]*?unchanged: headless workers on every turn/);
  for (const text of [COMMANDS.workers.description, COMMANDS.cleanup.flags.find((f) => f.name === "--dry-run").description]) {
    expect(text).toMatch(/export is on/);
    expect(text).toMatch(/queue records and start the (?:detached )?sender/);
  }
  for (const path of ["docs/contracts.md", "docs/guarantees.md", "skills/routr/references/orchestrator.md"]) {
    expect(read(path)).toMatch(/`workers`[^\n]*`cleanup --dry-run`[\s\S]{0,120}queue records and start the (?:detached )?(?:OpenTelemetry )?sender/);
  }
});

