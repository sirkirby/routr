import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("source, tests and scripts explain decisions without private review labels", () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : []);
  for (const dir of ["src", "test", "scripts"]) for (const file of walk(join(import.meta.dir, "..", dir))) {
    if (file.endsWith("comment-reasons.test.mjs")) continue;
    const comments = readFileSync(file, "utf8").split("\n").flatMap((line) => line.match(/(?:^|\s)\/\/(.*)/)?.[1] ?? []).join("\n");
    expect(comments.match(/W3-\d+|\bV(?:10|11)\b|\breview [A-E]\b|\bthe final review\b|\bStage [123]\b|from (?:the |#\d+'s |\w+ )*reviews?\b|\breview (?:decision|\d)/i)?.[0] ?? null, file).toBeNull();
  }
});
