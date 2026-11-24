#!/usr/bin/env bash
# Builds a SonicMesh app for the XIAO nRF52840 Sense.
#   tools/build.sh node|gateway [extra west build args]
# Output: firmware/build/<app>/zephyr/zephyr.hex and .uf2
set -euo pipefail
APP=${1:?usage: build.sh node|gateway}
shift
FW=$(cd "$(dirname "$0")/.." && pwd)
ZP=${ZEPHYR_PROJECT:-$HOME/zephyrproject}
# shellcheck disable=SC1091
source "$ZP/.venv/bin/activate"
export ZEPHYR_BASE=$ZP/zephyr
export ZEPHYR_SDK_INSTALL_DIR=${ZEPHYR_SDK_INSTALL_DIR:-$(ls -d "$HOME"/zephyr-sdk-* | sort -V | tail -1)}
west build -b xiao_ble/nrf52840/sense -d "$FW/build/$APP" "$FW/apps/$APP" \
	-- -DEXTRA_CONF_FILE="$FW/apps/common.conf" -DEXTRA_DTC_OVERLAY_FILE="$FW/apps/usb_console.overlay" "$@"
