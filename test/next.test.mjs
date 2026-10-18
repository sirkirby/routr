// The receiving runtime, through real shells, is the oracle: never a splitter that repeats our renderer.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { commandLine, doNext, runNext } from "../src/lib/next.mjs";

const words = ["plain", "Letters09_./:=@+-,", "two words", " leading", "trailing ", " ", "C:\\work\\task.md", "C:\\two words\\task.md", "@account", "a,b", "--level=standard"];
test("next separates runnable argv, stdout destination, and instructions", () => {
  expect(runNext("save advice", ["routr", "dispatch", "--task-file", "two words"], "advice.json")).toEqual({
    kind: "run", why: "save advice", argv: ["routr", "dispatch", "--task-file", "two words"],
    command: 'routr dispatch --task-file "two words"', stdout_to: "advice.json",
  });
  expect(doNext("verify", "routr record --model <model>")).toEqual({ kind: "do", why: "verify", template: "routr record --model <model>" });
  for (const word of words) expect(commandLine(["routr", word])).not.toBeNull();
  for (const word of ["", "a\\\\b", "\\\\server\\share", "C:\\work\\", "a\tb", "a\nb", "a\rb", "a\0b", "é", "a'b", 'a"b', "$HOME", "`id`", "a;b", "a&b", "a|b", "a<b", "a>b", "%PATH%", "!var!", "(x)", "[x]", "{x}", "*", "?", "#x", "~home", "^x"]) {
    const step = runNext("unsafe string; use argv", ["routr", word]);
    expect([word, step.command]).toEqual([word, null]);
    expect(step.argv).toEqual(["routr", word]);
  }
});

const receiver = join(import.meta.dir, "fixtures", "argv.mjs");
const line = () => commandLine(["bun", receiver, ...words]);
for (const [shell, flags, enabled] of [
  ["bash", ["-c"], process.platform !== "win32"],
  ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command"], process.platform === "win32"],
  ["pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command"], process.platform === "win32"],
  ["cmd.exe", ["/d", "/s", "/c"], process.platform === "win32"],
]) (enabled ? test : test.skip)(`next command preserves exact argv through ${shell}`, () => {
  const command = line();
  expect(command).not.toBeNull();
  const r = Bun.spawnSync([shell, ...flags, command], { stdin: "ignore" });
  expect({ code: r.exitCode, err: r.stderr.toString().trim() }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(r.stdout.toString())).toEqual(words);
});
