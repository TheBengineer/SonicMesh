#!/usr/bin/env bash
# Sets up the build toolchain for the SonicMesh firmware. Run once per machine:
#   firmware/tools/install_toolchain.sh
#
# It installs:
#   - Zephyr v4.5.0 into ~/zephyrproject, with a Python venv (.venv) and west. Only the modules the
#     firmware needs are fetched (CMSIS, hal_nordic, segger, tinycrypt, mbedtls, picolibc, cmsis-dsp),
#     narrow and depth 1, so the checkout stays small.
#   - The Zephyr SDK 1.0.1 minimal bundle and its ARM (arm-zephyr-eabi) toolchain into
#     ~/zephyr-sdk-1.0.1.
#   - adafruit-nrfutil, which the flashing tools do not use but which is handy for serial DFU.
# Expect about 2-3 GB of downloads and disk use.
# Idempotent: each step is skipped when its result already exists (.venv, .west, zephyr-sdk-1.0.1),
# so a failed run can be repeated. Delete those directories to force a fresh install.
# Requires git, python3 with venv, curl, tar and xz.
set -euo pipefail
ZP=$HOME/zephyrproject
SDKV=1.0.1
mkdir -p "$ZP"
cd "$ZP"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
source .venv/bin/activate
pip install -q --upgrade pip west
if [ ! -d .west ]; then west init -m https://github.com/zephyrproject-rtos/zephyr --mr v4.5.0 .; fi
west config manifest.project-filter -- '-.*,+cmsis,+cmsis_6,+hal_nordic,+segger,+tinycrypt,+mbedtls,+picolibc,+cmsis-dsp'
west update --narrow -o=--depth=1
pip install -q -r zephyr/scripts/requirements-base.txt
west zephyr-export
pip install -q adafruit-nrfutil
cd "$HOME"
if [ ! -d "zephyr-sdk-$SDKV" ]; then
  B=https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v$SDKV
  curl -sSL -o /tmp/zsdk-min.tar.xz "$B/zephyr-sdk-${SDKV}_linux-x86_64_minimal.tar.xz"
  tar xf /tmp/zsdk-min.tar.xz && rm /tmp/zsdk-min.tar.xz
  cd "zephyr-sdk-$SDKV"
  mkdir -p gnu
  curl -sSL -o /tmp/arm.tar.xz "$B/toolchain_gnu_linux-x86_64_arm-zephyr-eabi.tar.xz"
  tar xf /tmp/arm.tar.xz -C gnu && rm /tmp/arm.tar.xz
  ./setup.sh -c || true
fi
ls "$HOME/zephyr-sdk-$SDKV" "$HOME/zephyr-sdk-$SDKV/gnu"
echo INSTALL_DONE
