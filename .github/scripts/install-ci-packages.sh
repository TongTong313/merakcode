#!/usr/bin/env bash
# Install CI packages. Ripgrep comes from GitHub releases so apt DNS flakes do not block tests.
# Extra Linux packages (desktop e2e) still use apt, with retries and short timeouts.
set -euo pipefail

packages=("$@")
if [[ ${#packages[@]} -eq 0 ]]; then
  echo "usage: install-ci-packages.sh <package>..." >&2
  exit 1
fi

install_ripgrep_from_github() {
  local version="14.1.1"
  local archive=""
  local dir=""
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      archive="ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz"
      dir="ripgrep-${version}-x86_64-unknown-linux-musl"
      ;;
    Linux-aarch64)
      archive="ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz"
      dir="ripgrep-${version}-aarch64-unknown-linux-gnu"
      ;;
    Darwin-x86_64)
      archive="ripgrep-${version}-x86_64-apple-darwin.tar.gz"
      dir="ripgrep-${version}-x86_64-apple-darwin"
      ;;
    Darwin-arm64)
      archive="ripgrep-${version}-aarch64-apple-darwin.tar.gz"
      dir="ripgrep-${version}-aarch64-apple-darwin"
      ;;
    *)
      echo "unsupported platform for ripgrep download: $(uname -s)-$(uname -m)" >&2
      exit 1
      ;;
  esac

  local url="https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archive}"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "${url}" -o "${tmp}/${archive}"
  tar -xzf "${tmp}/${archive}" -C "${tmp}"
  if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
    sudo cp "${tmp}/${dir}/rg" /usr/local/bin/rg
  else
    sudo cp "${tmp}/${dir}/rg" /usr/local/bin/rg
  fi
  sudo chmod +x /usr/local/bin/rg
  rg --version
  rm -rf "${tmp}"
}

apt_install_with_retry() {
  local -a apt_packages=("$@")
  if [[ ${#apt_packages[@]} -eq 0 ]]; then
    return 0
  fi
  local attempt=1
  local max_attempts=5
  local apt_opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
  while true; do
    if sudo apt-get "${apt_opts[@]}" update -qq \
      && sudo DEBIAN_FRONTEND=noninteractive apt-get "${apt_opts[@]}" install -y -qq "${apt_packages[@]}"; then
      return 0
    fi
    if ((attempt >= max_attempts)); then
      echo "apt install failed after ${max_attempts} attempts: ${apt_packages[*]}" >&2
      return 1
    fi
    local sleep_secs=$((attempt * 15))
    echo "apt install failed (attempt ${attempt}/${max_attempts}); retrying in ${sleep_secs}s..." >&2
    sleep "${sleep_secs}"
    attempt=$((attempt + 1))
  done
}

need_ripgrep=0
extra_linux=()
for package in "${packages[@]}"; do
  if [[ "${package}" == "ripgrep" ]]; then
    need_ripgrep=1
  else
    extra_linux+=("${package}")
  fi
done

case "${RUNNER_OS:-}" in
  Linux)
    if ((need_ripgrep)); then
      install_ripgrep_from_github
    fi
    apt_install_with_retry "${extra_linux[@]+"${extra_linux[@]}"}"
    ;;
  macOS)
    # Desktop workflow always passes Linux library names; ignore them off Linux.
    if ((need_ripgrep)); then
      install_ripgrep_from_github
    fi
    ;;
  Windows)
    if ((need_ripgrep)); then
      choco install ripgrep -y --no-progress
    fi
    ;;
  *)
    echo "unsupported RUNNER_OS=${RUNNER_OS:-}" >&2
    exit 1
    ;;
esac
