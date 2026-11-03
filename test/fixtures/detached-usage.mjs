// Native fixture: it must observe only inherited env, without Bun's source-script dotenv loading of its own.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.execPath).replace(/\.exe$/, ""), args = process.argv.slice(2);
const dirty = process.env.ROUTR_DETACHED_DOTENV === "1";
appendFileSync(process.env.ROUTR_FIXTURE_CALLS, JSON.stringify({ name, dirty, usage: args.includes("/usage") }) + "\n");
const say = (o) => console.log(JSON.stringify(o));
if (name === "claude") {
  if (args[0] === "auth") say({ loggedIn: true, authMethod: dirty ? "api_key" : "claude.ai", subscriptionType: "enterprise" });
  else say({ subtype: "success", num_turns: 0, is_error: false, result: "You are currently using your subscription to power your Claude Code usage" });
} else if (name === "kiro-cli") {
  if (args[0] === "whoami") say({ email: "fixture" });
  else if (!dirty) say({ type: "runFinished", data: { finalText: "Estimated Usage | KIRO FREE\nCredits (10 of 100 covered in plan), 10.0%" } });
} else if (name === "cursor-agent") console.log("Logged in as fixture");
else if (name === "herdr") {
  const a = args[0] === "--session" ? args.slice(2) : args;
  let s; try { s = JSON.parse(readFileSync(process.env.ROUTR_FIXTURE_SCREEN, "utf8")); } catch { s = { stage: "shell" }; }
  const ok = (result) => say({ ok: true, result });
  if (a[0] === "session") { say({ sessions: [] }); }
  else if (a[0] === "workspace" && a[1] === "list") ok({ workspaces: [] });
  else if (a[0] === "workspace" && a[1] === "create") { s.cwd = a[a.indexOf("--cwd") + 1]; ok({ root_pane: { pane_id: "fixture:p1" } }); }
  else if (a[1] === "process-info") ok({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh", cwd: s.cwd }, ...(!dirty && s.stage !== "shell" ? [{ pid: 2, name: process.env.ROUTR_FIXTURE_SEAT }] : [])] } });
  else if (a[1] === "read") {
    const claude = process.env.ROUTR_FIXTURE_SEAT === "claude";
    const text = s.stage === "shell" ? "fixture % " : s.stage === "menu" ? "❯ /usage Fixture built-in" : s.stage === "panel"
      ? claude ? readFileSync(process.env.ROUTR_FIXTURE_PANEL, "utf8") : "Usage • Pro\nIncluded 14% used"
      : claude ? "Claude Code\n❯ \n? for shortcuts" : "Cursor Agent";
    ok({ text });
  } else {
    if (a[1] === "run") s.stage = "ready";
    if (a[1] === "send-text") s.stage = "menu";
    if (a[1] === "send-keys" && a.at(-1) === "enter") s.stage = "panel";
    ok({});
  }
  writeFileSync(process.env.ROUTR_FIXTURE_SCREEN, JSON.stringify(s));
}
