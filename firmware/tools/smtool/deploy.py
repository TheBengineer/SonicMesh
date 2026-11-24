"""Prepares sensor nodes for a field test: optional flash, field tuning, save, health check, one line each.

  sm deploy [PORT ...] [--flash] [--tuning FILE] [--sync-wait S] [--no-sync] [--log FILE] [--names FILE]

With no ports, every serial port is tried, and a gateway is listed as skipped. Each node gets the values
of the tuning file (a flat JSON object, "param.name": value), they are saved to flash and read back, and
then `sm status` is polled until the node passes or the sync wait runs out. A board that fails prints its
reasons after " | ". One JSON record per board is appended to the log. A board that raises an error is
reported as FAIL and the other boards still run.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

from . import REPO_ROOT
from .device import Board, DeviceError, SET_TOLERANCE, list_ports
from smlog import load_names

MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
FIRMWARE = os.path.abspath(os.path.join(MODULE_DIR, "..", ".."))
DEFAULT_TUNING = os.path.join(MODULE_DIR, "field.json")
LOG_DIR = os.path.join(REPO_ROOT, "data", "field")
FLASH_TIMEOUT_S = 120
FLASH_WAIT_S = 30.0
FLASH_POLL_S = 1.0
POLL_S = 2.0
RATE_HZ = 16000.0
RATE_TOL = 0.005  # relative
LEVEL_MIN_DB = 25.0
LEVEL_MAX_DB = 100.0
BATT_LOW_MV = 3500
REQUIRED_ON = ("drone_comb.enable", "gunshot.enable")

# Time functions, replaced in the tests.
SLEEP = time.sleep
CLOCK = time.monotonic


class DeployFail(Exception):
    """A check failed for one board. The message is the reason shown on its line."""


# ---- steps ------------------------------------------------------------------------------------

def flash_node(port):
    """Flashes the node app with tools/flash.sh. Returns the exit status, or -1 if it did not run to the end."""
    script = os.path.join(FIRMWARE, "tools", "flash.sh")
    try:
        return subprocess.run([script, "node", port], timeout=FLASH_TIMEOUT_S).returncode
    except (subprocess.TimeoutExpired, OSError):
        return -1


def node_id_at(port):
    """The node id of the node board answering on port, or None."""
    try:
        board = Board(port).open()
    except (DeviceError, OSError):
        return None
    try:
        info = board.info()
        return board.node_id if info.get("role") == "node" else None
    except (DeviceError, OSError):
        return None
    finally:
        board.close()


def flash_and_find(port, node_id):
    """Flashes the board on port and returns the port it comes back on. Its ttyACM number can change."""
    if flash_node(port) != 0:
        raise DeployFail("flash failed")
    start = CLOCK()
    while True:
        for candidate in list_ports():
            if node_id_at(candidate) == node_id:
                return candidate
        if CLOCK() - start >= FLASH_WAIT_S:
            raise DeployFail("did not come back after flashing")
        SLEEP(FLASH_POLL_S)


def load_tuning(path):
    """The tuning file: a flat JSON object of parameter names to numbers."""
    with open(path, encoding="utf-8") as fh:
        values = json.load(fh)
    if not isinstance(values, dict):
        raise ValueError(f"{path} must be a JSON object")
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{path}: {name} must be a number")
    return values


def apply_tuning(board, values):
    """Sets, saves and reads back the tuning values. A value the board does not keep fails the board."""
    if not values:
        return
    # Only values that differ are sent: setting a detector's parameter restarts that detector, even
    # to the same value, and the drone detector drops about 0.7 s of audio while it restarts.
    have_now = board.get(list(values))
    changed = {n: v for n, v in values.items() if not _same(have_now.get(n), v)}
    if changed:
        board.set(changed)
        board.save()
    back = board.get(list(values))
    for name, want in values.items():
        have = back.get(name)
        if not _same(have, want):
            raise DeployFail(f"tuning {name} set to {want} but the board reads {have}")


def _same(have, want):
    return have is not None and abs(float(have) - float(want)) <= SET_TOLERANCE * max(1.0, abs(float(want)))


def read_status(board):
    for obj in board.call("sm status"):
        if obj.get("k") == "status":
            return obj
    raise DeviceError("no status line in the answer to sm status")


def status_checks(status, no_sync):
    """(fails, warns) for one sm status answer. Only fails are retried by the health poll."""
    fails = []
    warns = []
    if not no_sync and status.get("synced") != 1:
        fails.append("not synced")
    rate = status.get("rate_hz")
    if rate is None or abs(rate - RATE_HZ) > RATE_TOL * RATE_HZ:
        fails.append(f"audio rate {_num(rate, '.2f')}")
    level = status.get("level_db")
    if level is None or not LEVEL_MIN_DB <= level <= LEVEL_MAX_DB:
        fails.append(f"mic level {_num(level, '.1f')} dB")
    dropped = status.get("dropped", 0)
    block_drops = status.get("block_drops", 0)
    if dropped or block_drops:
        warns.append(f"since boot: {dropped} records dropped, {block_drops} audio blocks dropped")
    batt = status.get("batt_mv")
    if batt is not None and 0 < batt < BATT_LOW_MV:
        warns.append(f"battery low {batt} mV")
    return fails, warns


def health_check(board, no_sync, sync_wait):
    """Polls sm status every POLL_S seconds until it passes or sync_wait seconds have gone by.
    Returns (last status, fails, warns)."""
    start = CLOCK()
    while True:
        status = read_status(board)
        fails, warns = status_checks(status, no_sync)
        if not fails or CLOCK() - start >= sync_wait:
            return status, fails, warns
        SLEEP(POLL_S)


def _num(value, spec=None):
    if value is None:
        return "-"
    return str(value) if spec is None else format(value, spec)


# ---- one board --------------------------------------------------------------------------------

def new_record(port):
    return {"port": port, "node": None, "name": "", "status": "FAIL", "build": None, "skip": None,
            "synced": None, "sync_ppm": None, "rate_hz": None, "level_db": None, "batt_mv": None,
            "fails": [], "warns": []}


def deploy_port(port, args, tuning, names):
    """Runs every step on one port and returns its record. Board errors become FAIL reasons."""
    rec = new_record(port)
    started = CLOCK()
    board = None
    try:
        board = Board(port).open()
        info = board.info()
        if info.get("role") != "node":
            rec["status"] = "SKIP"
            rec["skip"] = "gateway" if info.get("role") == "gateway" else f"role {info.get('role')}"
            return rec
        if args.flash:
            node_id = board.node_id
            board.close()
            board = None
            new_port = flash_and_find(port, node_id)
            rec["port"] = new_port
            board = Board(new_port).open()
            info = board.info()
            if info.get("role") != "node":
                raise DeployFail(f"came back as role {info.get('role')}")
        rec["node"] = info.get("node")
        rec["build"] = info.get("built")
        rec["name"] = names.get(str(board.node_id), "")

        apply_tuning(board, tuning)

        values = board.get(list(REQUIRED_ON))
        on_fails = []
        for name in REQUIRED_ON:
            if values.get(name) is None or float(values[name]) != 1.0:
                on_fails.append(f"{name} is {values.get(name)}, not 1")

        status, fails, warns = health_check(board, args.no_sync, args.sync_wait)
        rec.update(synced=status.get("synced"), sync_ppm=status.get("drift_ppm"),
                   rate_hz=status.get("rate_hz"), level_db=status.get("level_db"),
                   batt_mv=status.get("batt_mv"))
        rec["fails"] = fails + on_fails
        rec["warns"] = warns
        rec["status"] = "FAIL" if rec["fails"] else "PASS"
    except DeployFail as exc:
        rec["fails"].append(str(exc))
    except (DeviceError, OSError) as exc:
        rec["fails"].append(str(exc))
    finally:
        if board is not None:
            board.close()
        rec["wall_s"] = round(CLOCK() - started, 1)
    return rec


def format_line(rec, no_sync, tuning_name):
    if rec["status"] == "SKIP":
        return f"{rec['port']}  skipped ({rec['skip']})"
    if no_sync:
        sync = "sync off"
    elif rec["synced"] == 1:
        sync = f"sync ok {_num(rec['sync_ppm'], '.1f')} ppm"
    else:
        sync = "sync no"
    parts = [
        f"{rec['node'] or '----':<6}",
        f"{rec['name']:<14}",
        f"{rec['status']:<4}",
        f"build {_num(rec['build'])}",
        sync,
        f"rate {_num(rec['rate_hz'], '.1f')}",
        f"level {_num(rec['level_db'], '.1f')} dB",
        f"batt {_num(rec['batt_mv'])} mV",
        f"tuning {tuning_name}",
    ]
    line = "  ".join(parts)
    notes = [f"FAIL: {reason}" for reason in rec["fails"]] + [f"WARN: {w}" for w in rec["warns"]]
    if notes:
        line += " | " + "; ".join(notes)
    return line


def default_log_path():
    return os.path.join(LOG_DIR, f"deploy-{datetime.now().strftime('%Y%m%d')}.jsonl")


def append_log(path, rec, tuning_name):
    entry = dict(rec)
    entry["time"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    entry["tuning"] = tuning_name
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


# ---- command ----------------------------------------------------------------------------------

def cmd_deploy(args):
    try:
        tuning = load_tuning(args.tuning)
        names = load_names(args.names) if args.names else {}
    except (OSError, ValueError, SystemExit) as exc:
        print(f"sm deploy: {exc}", file=sys.stderr)
        return 1
    log = args.log or default_log_path()
    os.makedirs(os.path.dirname(os.path.abspath(log)), exist_ok=True)
    ports = list(args.ports) or list_ports()
    if not ports:
        print("sm deploy: no serial ports found", file=sys.stderr)
        return 1

    tuning_name = os.path.basename(args.tuning)
    records = []
    for port in ports:
        rec = deploy_port(port, args, tuning, names)
        records.append(rec)
        print(format_line(rec, args.no_sync, tuning_name), flush=True)
        append_log(log, rec, tuning_name)

    passed = [r for r in records if r["status"] == "PASS"]
    failed = [r for r in records if r["status"] == "FAIL"]
    builds = sorted({r["build"] for r in passed if r["build"]})
    if len(builds) > 1:
        print("mixed builds: " + ", ".join(builds))
    print(f"{len(passed)} PASS, {len(failed)} FAIL")
    if not passed and not failed:
        print("no node boards found")
    return 1 if failed or not passed else 0


def add_parser(subparsers):
    q = subparsers.add_parser("deploy", help="prepare nodes for a field test: flash, tune, save, health check")
    q.add_argument("ports", nargs="*", help="serial ports (default: every port, gateways are skipped)")
    q.add_argument("--flash", action="store_true", help="flash the node app before tuning")
    q.add_argument("--tuning", default=DEFAULT_TUNING,
                   help="flat JSON of parameter values to set and save (default: field.json here)")
    q.add_argument("--sync-wait", type=float, default=20.0, dest="sync_wait",
                   help="seconds to poll sm status for the checks to pass (default 20)")
    q.add_argument("--no-sync", action="store_true", dest="no_sync",
                   help="do not require time sync (no gateway on air)")
    q.add_argument("--log", default=None,
                   help="JSON lines file to append to (default: data/field/deploy-YYYYmmdd.jsonl)")
    q.add_argument("--names", default=None,
                   help="JSON object mapping a decimal node id to a friendly name")
    q.set_defaults(func=cmd_deploy)
    return q
