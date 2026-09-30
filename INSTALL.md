# Install routr

Paste this whole file into your coding agent (Claude Code, Codex, Cursor, ...) and ask it to install routr.
Everything below is written for the agent.

---

You are installing routr for the user: a skill and a small command that help a lead agent spread work across the
user's AI subscriptions. Work through the steps in order. Ask before you install or write anything, show what you
are about to write, and never print the user's API key.

**1. Install.** routr is one standalone binary; it needs no Node, Bun, or packages. Run the installer for this system:

   macOS and Linux:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh
   ```

   Windows (PowerShell):

   ```powershell
   irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex
   ```

It downloads the binary for this machine from the latest GitHub release, checks its checksum, puts it at
`~/.local/bin/routr`, and installs the routr skill to `~/.agents/skills/routr` (linked for Claude Code). If it says
`~/.local/bin` is not on the PATH, offer to add it to the user's shell profile, and use the full path meanwhile.

**2. Check.** Run `routr doctor`. It changes nothing. It shows which harnesses are installed and signed in (one that
is not signed in gets no work until the user signs in; doctor names the command), which have live usage, whether the
key works, each signed-in harness's current model list (for Claude Code, its aliases; its help says it also takes a model's full name), and a numbered list of what is left to do.

**3. Set up.** Read `~/.agents/skills/routr/references/setup.md` and follow it with the user: the TypeSafe API key
(they create one at https://console.typesafe.ai/keys and store it themselves with `routr key set`, so it never
passes through you), the config and the Claude usage statusline with `routr setup --yes --model <subscription>=<id> --reserve <subscription>=<share> --use <subscription>=normal ...`
(a default model and effort, the hardest work, reserve and normal/fallback account use per subscription, settled with the user; never edit the file by
hand), and, if they want orchestration, herdr and herdr's agent skill. A user who would rather choose on screen can
run `routr setup` in their own terminal instead.

After updating an existing install, recommend `routr setup` to review settings. Read the
[release notes](https://github.com/sirkirby/routr/releases) for any specific upgrade steps. An agent reviews choices
with the user and applies the agreed flags.

**4. Confirm.** Run `routr doctor` again and show it to the user, then one real call:

    routr dispatch "Rename getUsr to getUser in src/api/users.ts and update its call sites"

**5. Tell the user how to use it.** Inside a [herdr](https://herdr.dev) session, they ask their lead agent to "use
routr" for a piece of work. Sizing subagents works in any session, with or without herdr.
