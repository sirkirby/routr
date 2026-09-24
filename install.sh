#!/bin/sh
# Install routr on macOS or Linux: one standalone binary (no Node, no Bun) plus the routr skill for your agents.
#   curl -fsSL https://raw.githubusercontent.com/sirkirby/routr/main/install.sh | sh
# Settings: ROUTR_INSTALL_DIR (default ~/.local/bin), ROUTR_VERSION (default: latest release).
set -eu

dir="${ROUTR_INSTALL_DIR:-$HOME/.local/bin}"
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "routr: unsupported system $(uname -s); on Windows use install.ps1" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo "routr: unsupported processor $(uname -m)" >&2; exit 1 ;; esac
asset="routr-$os-$arch"
if [ -n "${ROUTR_VERSION:-}" ]; then base="https://github.com/sirkirby/routr/releases/download/v${ROUTR_VERSION#v}"; else base="https://github.com/sirkirby/routr/releases/latest/download"; fi
base="${ROUTR_DOWNLOAD_BASE:-$base}"   # for testing against a local server

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "routr: downloading $asset"
curl -fsSL "$base/$asset" -o "$tmp/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
want="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "routr: checksum mismatch for $asset; nothing was installed" >&2; exit 1; }

mkdir -p "$dir"
mv "$tmp/$asset" "$dir/routr"
chmod +x "$dir/routr"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$dir/routr" 2>/dev/null || true
echo "routr: installed $("$dir/routr" --version) to $dir/routr"
echo "routr: it sends anonymous outcomes once a day to tune its questions, never your briefs or any text. See: routr share; stop: routr telemetry off"
"$dir/routr" skill install >/dev/null && echo "routr: skill installed to ~/.agents/skills/routr"
case ":$PATH:" in *":$dir:"*) ;; *) echo "routr: add $dir to your PATH so agents can run \`routr\`" ;; esac
# A person at a terminal goes straight into setup (`curl | sh` leaves stdin on the pipe, so read from the terminal).
# An agent or a script has no terminal: it gets the next step as a line instead. ROUTR_NO_SETUP=1 skips it.
if [ -z "${ROUTR_NO_SETUP:-}" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
  echo "routr: starting setup (Ctrl+C to stop; run \`routr setup\` any time)"
  "$dir/routr" setup </dev/tty || true
else
  echo "routr: next, run: routr setup   (or ask your coding agent to \"set up routr\")"
fi
