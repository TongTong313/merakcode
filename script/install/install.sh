#!/bin/sh
# MerakCode installer for Linux and macOS
#
#   curl -fsSL https://github.com/{{REPOSITORY}}/releases/latest/download/install.sh | sh
#
# Installs into ~/.merakcode/versions/<version>/ and links the `merak` command into ~/.local/bin.
# Upgrade later with `merak upgrade`.
#
# Environment variables:
#   MERAKCODE_VERSION        version to install (default: latest release)
#   MERAKCODE_INSTALL_DIR    install directory (default: MERAKCODE_HOME, else ~/.merakcode)
#   MERAKCODE_BIN_DIR        where the command goes (default: ~/.local/bin)
#   MERAKCODE_DOWNLOAD_BASE  download location (default: GitHub Releases; set it to use a mirror)
set -eu

repository="{{REPOSITORY}}"
home="${MERAKCODE_INSTALL_DIR:-${MERAKCODE_HOME:-$HOME/.merakcode}}"
bin="${MERAKCODE_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'Install failed: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s). On Windows, run install.ps1 in PowerShell" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
# A terminal running under Rosetta on Apple silicon reports x86_64; install the native arm64 build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "musl-based systems (such as Alpine) are not supported yet; use a glibc distribution"
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --tries=3 "$1" -O "$2"; }
else
  fail "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
else
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

version="${MERAKCODE_VERSION:-}"
if [ -z "$version" ]; then
  fetch "https://api.github.com/repos/$repository/releases/latest" "$work/latest.json" || fail "could not find the latest version"
  version=$(sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' "$work/latest.json" | head -n 1)
  [ -n "$version" ] || fail "could not find the latest version"
fi
base="${MERAKCODE_DOWNLOAD_BASE:-https://github.com/$repository/releases/download/v$version}"
name="merakcode-$version-$os-$arch"

printf 'Downloading MerakCode %s (%s-%s)\n' "$version" "$os" "$arch"
fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || fail "could not download SHA256SUMS"
fetch "$base/$name.tar.gz" "$work/$name.tar.gz" || fail "could not download $name.tar.gz"
expected=$(grep "  $name.tar.gz\$" "$work/SHA256SUMS" | cut -d' ' -f1)
[ -n "$expected" ] || fail "$name.tar.gz is not listed in SHA256SUMS"
[ "$(digest "$work/$name.tar.gz")" = "$expected" ] || fail "checksum mismatch: the download is incomplete or has been tampered with"

tar -xzf "$work/$name.tar.gz" -C "$work"
mkdir -p "$home/versions" "$bin"
rm -rf "$home/versions/$version"
mv "$work/$name" "$home/versions/$version"
ln -sfn "$home/versions/$version/bin/merak" "$bin/merak"

if [ "$os" = linux ] && ! "$home/versions/$version/node/bin/node" --version >/dev/null 2>&1; then
  printf '\nNote: the bundled Node does not start. This usually means libatomic is missing:\n' >&2
  printf '  Debian / Ubuntu: sudo apt install libatomic1\n  Fedora / RHEL: sudo dnf install libatomic\n' >&2
fi

printf '\nMerakCode %s is installed: %s\n' "$version" "$bin/merak"
case ":$PATH:" in
  *":$bin:"*) printf "Run 'merak --help' to see the commands.\n" ;;
  *)
    printf '\n%s is not on your PATH. Add this line to your shell profile (~/.bashrc, ~/.zshrc, ...) and open a new terminal:\n' "$bin"
    printf '  export PATH="%s:$PATH"\n' "$bin"
    ;;
esac
