# Troubleshooting

Start with `routr doctor`. It changes nothing and says what is missing: the key, the config, a harness that is not on
your PATH, herdr or its skill, the Claude usage statusline.

## `routr: command not found`

The installer puts `routr` in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) and tells you when that folder
is not on your PATH. Add it to your shell profile, or to your user PATH on Windows, and open a new terminal.

## macOS: the binary is killed, or "cannot be verified"

From 0.3.2 on, routr's macOS binaries are signed with a Developer ID and notarized by Apple, and each release checks
that Gatekeeper accepts a copy downloaded in a browser. Releases before 0.3.2 were signed ad hoc only. macOS blocks
the first run of such a binary when it was downloaded **in a browser** (browser downloads are quarantined), and a
macOS update can start killing an ad-hoc binary it ran before. The fix for both is to upgrade: `routr update`, or the
install script, which is never affected by quarantine (a download made with `curl` is not marked). To run an old one
you downloaded in a browser, clear the mark once:

```sh
xattr -d com.apple.quarantine ~/.local/bin/routr
```

## Updates

routr updates itself in the background, at most once a day, and the new version takes effect on your next run.
`routr doctor` shows when it last checked and the result. `routr update` updates now; `routr update --check` only
looks. To stop automatic updates, set `"auto_update": false` in `~/.config/routr/config.json`. Versions before
0.1.7 do not update themselves: run the install command once more.

## Every answer says `fallback`

routr could not reach TypeSafe: there is no key, the key is wrong, or there is no network. `routr doctor` shows which.
Create a key at https://console.typesafe.ai/keys and store it with `routr key set`. routr keeps answering without one,
but only with your fallback level.

## Claude's usage shows as "assumed"

Claude Code reports usage only to its statusline. Run `routr setup`, or set `routr statusline` as Claude's statusline command by hand (the setup
guide does this with you); the first reading appears after the next Claude Code turn.

## A subscription is left out: "not signed in"

routr asks each harness whether it is signed in before it asks it anything else, and one that is not gets no work:
dispatch lists it under `excluded` with the command to run, doctor says the same, and setup and launch skip it. Sign
in with that command; routr sees it within 10 minutes, or at once with `routr doctor`. routr never opens a sign-in
itself. "Did not answer its sign-in check" means the command is missing from PATH or hung.

## Cursor's usage is "assumed"

Cursor shows usage only in its own `/usage` screen. routr reads it in a private herdr session in the background (nothing
opens on your screen; herdr has to be installed), about once per working session, and keeps the reading in
`~/.cache/routr/cursor-usage.json`. Until the first reading lands, or when reading fails, Cursor is `assumed` and the
row's `note` says why. Run `routr usage cursor` to read it now and see any error; if it cannot be read at all, pass
`--headroom cursor=<share left>` yourself (0.9 or 90%) (its `read_yourself` says how to read the screen by hand).

## Kiro's usage is "assumed"

Kiro's `/usage` command takes about 10 seconds, so routr runs it in the background about once per working session, in
the system temp folder, and keeps the reading in `~/.cache/routr/kiro-usage.json`. Each run leaves an empty saved
session in Kiro, which routr deletes with `kiro-cli chat --delete-session`; if that fails, the reading's `note` gives
the command. Until the first reading lands, or when reading fails, Kiro is `assumed` and the row's `note` says why.
Run `routr usage kiro` to read it now; if it cannot be read, pass `--headroom kiro=<share left>` yourself (0.9 or 90%).
