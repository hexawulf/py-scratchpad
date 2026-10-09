#!/usr/bin/env bash
#
# Author:      0xWulf <zk@hexawulf.dev>
# Description: Run the Playwright smoke test against the real container image
#              rather than against `vite preview`.
# Modified:    2026-10-09
#
# Why this exists: `vite preview` is a Vite dev server and types `.mjs` as
# JavaScript; nginx has no mapping for `.mjs` at all. So the suite can pass
# against preview while the shipped image serves `pyodide.mjs` as
# application/octet-stream, which a browser refuses to execute as a module —
# and every Run fails. That is exactly what 0.3.0 shipped. This script closes
# the gap by pointing the same tests at the same nginx config the image runs.
#
# Usage:  npm run test:e2e:image
#         KEEP=1 npm run test:e2e:image     # leave the container up to poke at
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="py-scratchpad:e2e"
NAME="py-scratchpad-e2e"
PORT="${PORT:-5041}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_DIR="${HOME}/logs"
LOG="${LOG_DIR}/py-scratchpad-e2e-image_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "${LOG_DIR}"

# Colour, with a non-interactive fallback.
if [ -t 1 ]; then
    BOLD=$'\e[1m'; GREEN=$'\e[32m'; RED=$'\e[31m'; RESET=$'\e[0m'
else
    BOLD=''; GREEN=''; RED=''; RESET=''
fi

say() { printf '%s==>%s %s\n' "${BOLD}" "${RESET}" "$*" | tee -a "${LOG}"; }
fail() { printf '%sFAIL%s %s\n' "${RED}" "${RESET}" "$*" | tee -a "${LOG}"; }

cleanup() {
    if [ "${KEEP:-0}" = "1" ]; then
        say "KEEP=1 — leaving ${NAME} on ${BASE_URL}"
        return
    fi
    docker rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "log: ${LOG}"

# The image dates itself from the source, exactly as release.yml does, so this
# build is the same bytes a published one would be.
say "building ${IMAGE}"
docker build \
    --build-arg "SOURCE_DATE_EPOCH=$(git -C "${REPO}" log -1 --format=%ct)" \
    -t "${IMAGE}" "${REPO}" >>"${LOG}" 2>&1

say "starting ${NAME} on ${BASE_URL} (read-only, as piapps2 runs it)"
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" \
    -p "127.0.0.1:${PORT}:80" \
    --read-only --memory 64m \
    --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /tmp \
    "${IMAGE}" >>"${LOG}" 2>&1

for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "${BASE_URL}/"; then break; fi
    sleep 1
done

if ! curl -sf -o /dev/null "${BASE_URL}/"; then
    fail "the container never answered on ${BASE_URL}"
    docker logs "${NAME}" 2>&1 | tail -20 | tee -a "${LOG}"
    exit 1
fi

# The three Content-Types that have to be right or the runtime cannot start.
# Checked here as well as in the browser, so a failure names the file.
say "checking the runtime's Content-Types"
status=0
VERSION="$(node -p 'require("'"${REPO}"'/package.json").dependencies.pyodide')"
while read -r file expected; do
    [ -n "${file}" ] || continue
    got="$(curl -s -o /dev/null -w '%{content_type}' "${BASE_URL}/pyodide/${VERSION}/${file}")"
    case "${got}" in
        "${expected}"*) printf '  %-20s %s\n' "${file}" "${got}" | tee -a "${LOG}" ;;
        *)
            fail "${file}: expected ${expected}, got ${got}"
            status=1
            ;;
    esac
done <<'EXPECTED'
pyodide.mjs text/javascript
pyodide.asm.mjs text/javascript
pyodide.asm.wasm application/wasm
pyodide-lock.json application/json
python_stdlib.zip application/zip
LICENSE text/plain
EXPECTED

[ "${status}" -eq 0 ] || exit 1

say "running the smoke test against the image"
PY_SCRATCHPAD_BASE_URL="${BASE_URL}" npx playwright test "$@" 2>&1 | tee -a "${LOG}"

printf '%sOK%s image smoke test passed\n' "${GREEN}" "${RESET}" | tee -a "${LOG}"
