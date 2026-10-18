// The changelog is the short history beside each release's detailed notes (CONTRIBUTING.md). The release workflow
// finds a stable tag's section by its heading, so the headings must keep their one shape.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
// Windows checks the file out with CRLF line endings: split on either.
const headings = text.split(/\r?\n/).filter((l) => l.startsWith("## "));

test("the changelog opens with Unreleased, then one section per stable release, newest first", () => {
  expect(headings[0]).toBe("## Unreleased");
  const releases = headings.slice(1);
  for (const h of releases) expect(h).toMatch(/^## v\d+\.\d+\.\d+ — \d{4}-\d{2}-\d{2}$/);
  const versions = releases.map((h) => h.match(/v(\d+)\.(\d+)\.(\d+)/).slice(1).map(Number));
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [versions[i - 1], versions[i]];
    expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThan(b[0] * 1e6 + b[1] * 1e3 + b[2]);
  }
  expect(new Set(releases).size).toBe(releases.length);
});

test("each release links to its detailed notes, and the file is there", () => {
  for (const v of text.matchAll(/^## (v\d+\.\d+\.\d+) — /gm)) {
    expect(text).toContain(`[Full notes](docs/releases/${v[1]}.md)`);
    expect(() => readFileSync(new URL(`../docs/releases/${v[1]}.md`, import.meta.url))).not.toThrow();
  }
});
