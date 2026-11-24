#!/usr/bin/env bash
# Builds a SonicMesh app.
#   tools/build.sh node|gateway [board] [extra west build args]
# board: nrf (default, XIAO nRF52840 Sense), s3 (XIAO ESP32-S3) or s3sense (XIAO ESP32-S3 Sense).
# Output: firmware/build/<app> for nrf (zephyr.hex and .uf2), firmware/build/<app>-<board> otherwise.
set -euo pipefail
APP=${1:?usage: build.sh node|gateway [nrf|s3|s3sense]}
shift
BOARD=nrf
case "${1:-}" in nrf|s3|s3sense) BOARD=$1; shift ;; esac
FW=$(cd "$(dirname "$0")/.." && pwd)
ZP=${ZEPHYR_PROJECT:-$HOME/zephyrproject}
# shellcheck disable=SC1091
source "$ZP/.venv/bin/activate"
export ZEPHYR_BASE=$ZP/zephyr
export ZEPHYR_SDK_INSTALL_DIR=${ZEPHYR_SDK_INSTALL_DIR:-$(ls -d "$HOME"/zephyr-sdk-* | sort -V | tail -1)}
case $BOARD in
	nrf)
		west build -b xiao_ble/nrf52840/sense -d "$FW/build/$APP" "$FW/apps/$APP" \
			-- -DEXTRA_CONF_FILE="$FW/apps/common.conf;$FW/apps/nrf52840.conf" \
			-DEXTRA_DTC_OVERLAY_FILE="$FW/apps/usb_console.overlay" "$@"
		;;
	s3|s3sense)
		TARGET=xiao_esp32s3/esp32s3/procpu
		[ "$BOARD" = s3sense ] && TARGET=$TARGET/sense
		west build -b "$TARGET" -d "$FW/build/$APP-$BOARD" "$FW/apps/$APP" \
			-- -DEXTRA_CONF_FILE="$FW/apps/common.conf;$FW/apps/esp32s3.conf" "$@"
		;;
esac
