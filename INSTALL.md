# Install routr

Paste this whole file into your coding agent (Claude Code, Codex, Cursor, ...) and ask it to install routr.
Everything below is written for the agent.

---

You are installing routr for the user: a skill that helps a lead agent spread work across the user's AI
subscriptions. Work through the steps in order. Ask before you install or write anything, show what you are about to
write, and never print the user's API key.

**1. Bun.** Run `bun --version`. If Bun is missing, offer to install it with its official installer
(`curl -fsSL https://bun.sh/install | bash` on macOS and Linux, `powershell -c "irm bun.sh/install.ps1 | iex"` on
Windows), then use `~/.bun/bin/bun` until the user's shell picks it up. routr needs nothing else: no Node, no packages.

**2. The skill.** Install it for every harness on this machine:

    bunx skills add sirkirby/routr -g -y

(`npx skills add sirkirby/routr -g -y` does the same if the user prefers Node.) The installer tries every harness it
detects and may report that one of them does not support global skills; that is harmless as long as it says the
skill was installed. It lands in `~/.agents/skills/routr`
and is linked into each harness's skills folder. If the user only uses Claude Code and prefers its plugin system:
`/plugin marketplace add sirkirby/routr`, then `/plugin install routr`. Either way, find the installed skill folder
and call it `<skill>` below.

**3. Check.** Run `bun <skill>/scripts/routr.mjs doctor`. It changes nothing. It shows which harnesses are installed,
which have live usage, whether the key works, and, with no config yet, a starter config and each harness's current
model list.

**4. Set up.** Read `<skill>/references/setup.md` and follow it with the user: the TypeSafe API key into
`~/.config/routr/env`, the config into `~/.config/routr/config.json` (reserves and a default model per subscription,
settled with the user), the Claude usage statusline if they use Claude Code, and the optional `routr` command.

**5. Confirm.** Run `doctor` again and show it to the user, then one real call:

    bun <skill>/scripts/routr.mjs dispatch "Rename getUsr to getUser in src/api/users.ts and update its call sites"

**6. Tell the user how to use it.** For orchestration they need [herdr](https://github.com/herdrdev/herdr): inside a
herdr session, they ask their lead agent to "use routr" for a piece of work. Sizing subagents works in any session.
