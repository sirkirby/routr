# Troubleshooting

Start with `routr doctor`. It changes nothing and says what is missing: the key, the config, a harness that is not on
your PATH, herdr or its skill. Each harness's usage line names where the reading came from.

## `routr: command not found`

The installer puts `routr` in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) and tells you when that folder
is not on your PATH. Add it to your shell profile, or to your user PATH on Windows, and open a new terminal.

## macOS: the binary is killed, or "cannot be verified"

From 0.3.2 on, routr's macOS binaries are signed with a Developer ID and notarized by Apple. Before a stable release is
published, a copy marked the way a browser marks a download must pass Gatekeeper's check, and the Apple Silicon one must run (on a
CI runner; a pre-release reports that check but is published either way). Releases before 0.3.2 were signed ad hoc only. macOS
blocks the first run of such a binary when it was downloaded **in a browser** (browser downloads are quarantined), and
a macOS update has started killing another project's ad-hoc binary that ran before. The fix for both is to upgrade: `routr update`, or the
install script, which is never affected by quarantine (a download made with `curl` is not marked). To run an old one
you downloaded in a browser, clear the mark once:

```sh
xattr -d com.apple.quarantine ~/.local/bin/routr
```

## Updates

routr updates itself in the background, at most once a day, and the new version takes effect on your next run.
`routr doctor` shows when it last checked, the result, and a newer release that check saw on your channel; doctor
itself asks GitHub nothing. `routr update` updates now; `routr update --check` only looks. To stop automatic updates,
set `"auto_update": false` in `~/.config/routr/config.json`; doctor then reminds you that `routr update --check`
looks by hand. Versions before
0.1.7 do not update themselves: run the install command once more.

Both follow your update channel, which `routr doctor` shows: stable releases, unless you chose beta builds with
`routr setup --channel beta`. Back on stable after a beta, routr stays on that beta until a stable release is newer;
`routr update --force` installs the newest stable now.

After updating, run `routr setup` to review settings and check the
[release notes](https://github.com/sirkirby/routr/releases) for specific upgrade steps.
If an agent still follows an older guide after the update, ask it to
reread the installed routr skill and its orchestration guide, or start a new session.

## Every answer starts with `no reading`

No decision-list entry answered, or a refused key or unreadable reply stopped the list. There may be no key or
network, or (with Ollama) the server is not running or the model is not pulled. `routr doctor` tests each entry and shows why, and the command that fixes it: a key is
stored with `routr key set` (TypeSafe's from https://console.typesafe.ai/keys; Cloudflare's token, with
Workers AI Read, and account ID), and a local model is fetched with `ollama pull <the tag doctor names>`. routr keeps
answering without a reading, but only with your fallback level. An earlier failure beside a later model's answer is
ordinary advice; its headline names the model that answered.

A Cloudflare token in your shell (`CLOUDFLARE_API_TOKEN`, as wrangler uses) wins over the one `routr key set` saved.
If doctor says the key was refused, that token may lack the Workers AI permission: unset it for routr, or give it
Workers AI Read.

With Ollama, the first brief after the model was unloaded waits for it to load (5 to 17 s for Clef Flash on an M4
Max, about 5 s on an NVIDIA laptop GPU); routr keeps it loaded for 15 minutes after each brief. `the local model is
not a decision model, or Ollama is too old` means to check the model and update Ollama to 0.40.1 or later, then restart
it (0.40.0 fails this way on Windows). A brief that times
out every time may be running on the CPU (`ollama ps` says): it took 36-41 s on a fast laptop CPU, and routr waits
30 s.

## Claude's usage shows as "assumed"

routr reads Claude's usage by running `claude -p /usage` (no tokens, about 4 to 5 s) in the system temp folder. The
usage note says why that failed: `claude` is not on routr's PATH, it did not answer in 12 s, or its answer showed no
usage windows (a seat with no quota: set `billing` for claude in the config). Run the same command yourself to see
what Claude says:

    claude -p /usage --output-format json --no-session-persistence --settings '{"disableAllHooks":true}' --strict-mcp-config

When it fails, routr uses the last `routr statusline` snapshot if there is one, however old (its age is shown), and
the assumed headroom otherwise. You do not need `routr statusline`; setup no longer sets it.

## A subscription is left out: "not signed in"

routr asks each harness whether it is signed in before it asks it anything else, and one that is not gets no work:
dispatch lists it under `excluded` with the command to run, doctor says the same, and setup and launch skip it. Sign
in with that command; routr sees it within 10 minutes, or at once with `routr doctor`. routr never opens a sign-in
itself. "Did not answer its sign-in check" means the command is missing from PATH or hung.

## Cursor's usage is "assumed"

Cursor shows usage only in its own `/usage` screen. routr reads it in a private herdr session in the background (nothing
opens on your screen; herdr has to be installed), about once per working session and again after routr is updated,
and keeps the reading in
`~/.cache/routr/cursor-usage.json`. Until the first reading lands, or when reading fails, Cursor is `assumed` and the
row's `note` says why. Run `routr usage cursor` to read it now and see any error; if it cannot be read at all, pass
`--headroom cursor=<share left>` yourself (0.9 or 90%) (the by-hand step in `next` says how to read the screen).

## Kiro's usage is "assumed"

Kiro's `/usage` command takes about 10 seconds, so routr runs it in the background about once per working session, in
the system temp folder, and keeps the reading in `~/.cache/routr/kiro-usage.json`. Each run leaves an empty saved
session in Kiro, which routr deletes with `kiro-cli chat --delete-session`; if that fails, the reading's `note` gives
the command. Until the first reading lands, or when reading fails, Kiro is `assumed` and the row's `note` says why.
Run `routr usage kiro` to read it now; if it cannot be read, pass `--headroom kiro=<share left>` yourself (0.9 or 90%).
