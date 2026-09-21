# Install routr

Paste this whole file into your coding agent (Claude Code, Codex, Cursor, ...) and ask it to install routr.
Everything below is written for the agent.

---

You are installing routr for the user: a skill and a small command that help a lead agent spread work across the
user's AI subscriptions. Work through the steps in order. Ask before you install or write anything, show what you
are about to write, and never print the user's API key.

**1. Install.** routr is one standalone binary; it needs no Node, Bun, or packages. Run the installer for this system:

    curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh          # macOS, Linux
    irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex               # Windows PowerShell

It downloads the binary for this machine from the latest GitHub release, checks its checksum, puts it at
`~/.local/bin/routr`, and installs the routr skill to `~/.agents/skills/routr` (linked for Claude Code). If it says
`~/.local/bin` is not on the PATH, offer to add it to the user's shell profile, and use the full path meanwhile.

**2. Check.** Run `routr doctor`. It changes nothing. It shows which harnesses are installed, which have live usage,
whether the key works, and, with no config yet, a starter config and each harness's current model list.

**3. Set up.** Read `~/.agents/skills/routr/references/setup.md` and follow it with the user: the TypeSafe API key
(they create one at https://console.typesafe.ai/keys and store it themselves with `routr key set`, so it never
passes through you), the config into `~/.config/routr/config.json` (reserves and a default model per
subscription, settled with the user), the Claude usage statusline if they use Claude Code, and, if they want
orchestration, herdr and herdr's agent skill.

**4. Confirm.** Run `routr doctor` again and show it to the user, then one real call:

    routr dispatch "Rename getUsr to getUser in src/api/users.ts and update its call sites"

**5. Tell the user how to use it.** Inside a [herdr](https://herdr.dev) session, they ask their lead agent to "use
routr" for a piece of work. Sizing subagents works in any session, with or without herdr.

Other ways to get the skill (the binary is still needed): `npx skills add sirkirby/routr -g`, or in Claude Code
`/plugin marketplace add sirkirby/routr` then `/plugin install routr`.
