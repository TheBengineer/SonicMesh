#!/usr/bin/env bash
# Flashes a built SonicMesh app to a XIAO nRF52840 Sense over USB, no buttons needed.
#   tools/flash.sh node|gateway /dev/ttyACMx
#
# Opens the port at 1200 baud, so the board restarts into its UF2 bootloader, which shows up as a
# USB drive (XIAO-SENSE). The script finds the drive on the same USB port and writes the .uf2 to it;
# the board flashes itself and restarts. A board whose firmware ignores the 1200 baud touch needs a
# double-tap on reset first; the script then finds the drive the same way.
#
# Serial DFU (adafruit-nrfutil) is not used: ModemManager probes new serial ports and swallowed the
# bootloader's replies on the development machine.
set -euo pipefail
APP=${1:?usage: flash.sh node|gateway /dev/ttyACMx}
PORT=${2:?usage: flash.sh node|gateway /dev/ttyACMx}
FW=$(cd "$(dirname "$0")/.." && pwd)
UF2=$FW/build/$APP/zephyr/zephyr.uf2
[ -f "$UF2" ] || { echo "no $UF2; run tools/build.sh $APP first"; exit 1; }

prop() { udevadm info -q property "$1" 2>/dev/null | sed -n "s/^$2=//p"; }
# USB device path without the interface, e.g. pci-0000:05:00.1-usb-0:1
usb_of() { prop "$1" ID_PATH | sed -E 's/:[0-9]+\.[0-9]+(-.*)?$//'; }

USB=$(usb_of "$PORT")
[ -n "$USB" ] || { echo "$PORT is not a USB serial port"; exit 1; }

find_disk() {
	for d in /dev/sd?; do
		[ -b "$d" ] || continue
		if [ "$(usb_of "$d")" = "$USB" ] && [ "$(prop "$d" ID_FS_LABEL)" = XIAO-SENSE ]; then
			echo "$d"
			return 0
		fi
	done
	return 1
}

find_port() {
	for p in /dev/ttyACM*; do
		[ "$(usb_of "$p")" = "$USB" ] && { echo "$p"; return 0; }
	done
	return 1
}

touch_port() {
	stty -F "$1" 1200 2>/dev/null || true
}

DISK=$(find_disk || true)
if [ -z "$DISK" ]; then
	touch_port "$PORT"
	for i in $(seq 1 60); do
		sleep 0.25
		DISK=$(find_disk || true)
		[ -n "$DISK" ] && break
		# A bootloader in serial-only mode has a port but no drive; touching it brings up the drive.
		if [ "$i" = 24 ]; then
			P=$(find_port || true)
			if [ -n "$P" ] && [ "$(prop "$P" ID_MODEL_ID)" = 0045 ]; then
				touch_port "$P"
			fi
		fi
	done
fi
[ -n "$DISK" ] || { echo "no XIAO-SENSE drive appeared on $USB; double-tap reset and retry"; exit 1; }

MNT=$(lsblk -no MOUNTPOINT "$DISK" | head -1)
for _ in $(seq 1 12); do
	[ -n "$MNT" ] && break
	sleep 0.5
	MNT=$(lsblk -no MOUNTPOINT "$DISK" | head -1)
done
if [ -z "$MNT" ]; then
	udisksctl mount -b "$DISK" >/dev/null
	MNT=$(lsblk -no MOUNTPOINT "$DISK" | head -1)
fi
echo "writing $APP to $DISK ($MNT)"
# The board restarts as soon as the last block lands, so the final write can report an I/O error.
dd if="$UF2" of="$MNT/NEW.UF2" bs=4096 conv=fsync oflag=direct status=none 2>/dev/null || true

for _ in $(seq 1 40); do
	sleep 0.25
	P=$(find_port || true)
	if [ -n "$P" ] && [ "$(prop "$P" ID_VENDOR_ID)" = 2fe3 ]; then
		echo "programmed $APP, running on $P"
		exit 0
	fi
done
echo "wrote the image but the board did not come back as SonicMesh firmware"
exit 1
