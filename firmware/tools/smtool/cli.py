"""The sm command line. Run `firmware/tools/sm --help`, or `sm <command> --help`.

Exit status: 0 ok, 1 usage or device error, 3 a hardware run passed its max duration (aborted).
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

from . import BENCH_DIR, capture, check, device, replay, run, score, scenario as scen, sweep, tuning
from .device import Board, CommandError, DeviceError

try:
    from . import measure
except ImportError:
    measure = None

try:
    from . import deploy
except ImportError:
    deploy = None
try:
    from . import rangetest
except ImportError:
    rangetest = None
try:
    from . import tones
except ImportError:
    tones = None

EXIT_USAGE = 1
EXIT_ABORTED = 3


def _die(msg, code=EXIT_USAGE):
    print(f"sm: {msg}", file=sys.stderr)
    return code


def _kv(items):
    out = {}
    for item in items or []:
        name, sep, value = item.partition("=")
        if not sep:
            raise ValueError(f"expected name=value, got {item!r}")
        out[name.strip()] = float(value)
    return out


def _stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _open(port):
    return Board(port).open()


def _each(ports, fn):
    """Runs fn(board) on every port; prints errors per port and returns the failure count."""
    failures = 0
    for port in ports:
        board = None
        try:
            board = _open(port)
            board.info()
            fn(board)
        except DeviceError as exc:
            failures += 1
            print(f"{port}: {exc}", file=sys.stderr)
        finally:
            if board is not None:
                board.close()
    return failures


# ---- board commands -------------------------------------------------------------------------

def cmd_ports(args):
    ports = device.list_ports()
    if not ports:
        print("no /dev/ttyACM* ports")
        return 0
    for port in ports:
        try:
            b = _open(port)
        except DeviceError as exc:
            print(f"{port}  (cannot open: {exc})")
            continue
        try:
            info = b.info()
            print(f"{port}  {info['role']:<8} node {b.node_id:04x}  build {info.get('built', '?')}")
        except DeviceError as exc:
            print(f"{port}  (no answer: {exc})")
        finally:
            b.close()
    return 0


def cmd_params(args):
    def show(b):
        rows = b.params(args.prefix or "")
        if args.json:
            print(json.dumps({"port": b.port, "params": rows}))
            return
        print(f"# {b.port}  {b.role}  node {b.node_id:04x}")
        for p in rows:
            print(f"{p['n']:<28} {p['v']:<12g} def {p['def']:<10g} [{p['min']:g}, {p['max']:g}]  {p['help']}")
    return _each(args.port, show) and EXIT_USAGE or 0


def cmd_get(args):
    def show(b):
        for name, value in b.get(args.names).items():
            print(f"{b.port} {name} {value:g}")
    return _each(args.port, show) and EXIT_USAGE or 0


def cmd_set(args):
    values = _kv(args.assignments)

    def apply(b):
        b.set(values)
        if args.save:
            b.save()
        print(f"{b.port}: set {len(values)} value(s)" + (" and saved" if args.save else ""))
    return _each(args.port, apply) and EXIT_USAGE or 0


def cmd_save(args):
    return _each(args.port, lambda b: b.save() or print(f"{b.port}: saved")) and EXIT_USAGE or 0


def cmd_reset(args):
    return _each(args.port, lambda b: b.reset(args.name) or print(f"{b.port}: reset")) and EXIT_USAGE or 0


def cmd_apply(args):
    try:
        values = tuning.load_tuning(args.tuning)
    except (OSError, ValueError) as exc:
        return _die(str(exc))

    def apply(b):
        known = {p["n"] for p in b.params()}
        names = {n: v for n, v in values.items() if n in known}
        missing = sorted(set(values) - set(names))
        if missing:
            print(f"{b.port}: not on this board, skipped: {', '.join(missing)}", file=sys.stderr)
        b.set(names)
        if args.save:
            b.save()
        print(f"{b.port}: applied {len(names)} value(s)" + (" and saved" if args.save else ""))
    return _each(args.port, apply) and EXIT_USAGE or 0


def cmd_dump(args):
    if len(args.port) != 1:
        return _die("dump takes exactly one --port")
    out = {}

    def collect(b):
        for p in b.params():
            if abs(p["v"] - p["def"]) > 1e-9 * max(1.0, abs(p["def"])):
                out[p["n"]] = int(p["v"]) if float(p["v"]).is_integer() else p["v"]
    rc = _each(args.port, collect)
    print(json.dumps(dict(sorted(out.items())), indent=2))
    return rc and EXIT_USAGE or 0


def cmd_trace(args):
    levels = _kv(args.streams)
    os.makedirs(BENCH_DIR, exist_ok=True)
    out_path = args.out or os.path.join(BENCH_DIR, f"{_stamp()}-trace.jsonl")
    fh = open(out_path, "w", encoding="utf-8")

    def write(board, wall, raw, obj):
        if obj is not None:
            fh.write(json.dumps(dict(obj, port=board.port)) + "\n")

    boards = []
    try:
        for port in args.port:
            b = Board(port)
            b.open()
            boards.append(b)
            b.info()
            b.trace_set(levels)
            b.add_listener(write)
        print(f"recording to {out_path}; Ctrl-C to stop", file=sys.stderr)
        deadline = time.monotonic() + args.seconds if args.seconds else None
        while deadline is None or time.monotonic() < deadline:
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    except DeviceError as exc:
        print(f"sm: {exc}", file=sys.stderr)
    finally:
        for b in boards:
            try:
                b.trace_off()
            except DeviceError as exc:
                print(f"{b.port}: could not turn traces off: {exc}", file=sys.stderr)
            b.close()
        fh.close()
    print(f"wrote {out_path}")
    return 0


def cmd_capture(args):
    if len(args.port) != 1:
        return _die("capture takes exactly one --port")
    board = None
    out = None
    try:
        board = _open(args.port[0])
        board.info()
        if args.stop:
            reply = board.command("sm capture stop")
            print(f"{board.port}: capture stop {'sent' if reply.ok else 'refused: ' + str(reply.error)}")
            return 0 if reply.ok else EXIT_USAGE
        if args.seconds is None:
            return _die("capture needs --seconds (or --stop)")
        out = args.out or os.path.join(BENCH_DIR, f"{_stamp()}-capture-{board.node_id:04x}.wav")
        play = {}
        timer = None

        def on_started():
            nonlocal timer
            if args.play:
                proc = subprocess.Popen(["paplay", args.play])
                play.update(proc=proc, path=args.play, start=time.time())
                timer = threading.Timer(args.seconds, lambda: proc.poll() is None and proc.kill())
                timer.daemon = True
                timer.start()

        print(f"{board.port}  node {board.node_id:04x}  capturing {args.seconds:g} s"
              + (f" while playing {args.play}" if args.play else "") + "; Ctrl-C stops", file=sys.stderr)
        cap = capture.record(board, args.seconds, on_started=on_started)
        if timer is not None:
            timer.cancel()
        proc = play.get("proc")
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        extra = {"play": {"path": play["path"], "start": play["start"]}} if play else None
        capture.save_wav(cap, out, extra=extra)
    except (DeviceError, ValueError, OSError) as exc:
        return _die(str(exc))
    finally:
        if board is not None:
            board.close()
    gaps = sum(n for _, n in cap.gaps)
    print(f"wrote {out} and {out}.json: {cap.samples.size} samples "
          f"({cap.samples.size / cap.rate_hz:.2f} s at {cap.rate_hz:.2f} Hz), "
          f"{len(cap.gaps)} gap(s) of {gaps} samples, board gaps {cap.board_gaps}")
    return 0


def cmd_check(args):
    try:
        result = check.check(args.run_dir)
    except (OSError, ValueError, KeyError, DeviceError) as exc:
        return _die(str(exc))
    print("\n".join(check.summary_lines(result)))
    print(f"\nwrote {os.path.join(args.run_dir, check.CHECK_FILE)}")
    return 0


# ---- offline ---------------------------------------------------------------------------------

def _print_events(events):
    for e in sorted(events, key=lambda e: e["t"]):
        if e["type"] == "SHOT":
            print(f"{e['t']:10.4f} s  SHOT   peak {e['peak_db']:.1f} dB  rise {e['rise_db']:.1f} dB")
        elif e["state"] == "update":
            continue
        else:
            print(f"{e['t']:10.4f} s  DRONE  {e['state']:<5}  f0 {e['f0_hz']:.1f} Hz  nharm {e['nharm']}  "
                  f"score {e['score']:.3f}  band {e['band_db']:.1f} dB")


CHAIN_OPTIONS = ("bench", "response", "levels", "noise", "noise_bed")


def _chain(args):
    """The bench chain for the options given, or None. Prints the notes of the bench lookup to stderr."""
    chain, notes = replay.chain_from_args(args.response, args.levels, args.noise, args.noise_bed, args.bench)
    for note in notes:
        print(f"note: {note}", file=sys.stderr)
    return chain


def _chain_line(chain, full_scale_db, quiet_spl_db):
    if chain is not None:
        return chain.header()
    return f"chain: none (full scale {full_scale_db:g} dB, quiet {quiet_spl_db:g} dB SPL white noise)"


def _print_score(result):
    t = result["totals"]
    lat = "-" if t["drone_mean_latency_s"] is None else f"{t['drone_mean_latency_s']:.2f} s"
    tail = "-" if t["drone_mean_tail_s"] is None else f"{t['drone_mean_tail_s']:.2f} s"
    print(f"score: cost {result['cost']:.2f}  drone {t['drone_detected']}/{t['drone_clips']} detected  "
          f"latency {lat}  tail {tail}  quiet shots {t['quiet_shots']}  false drone {t['drone_false_on_s']:.1f} s")


def cmd_replay(args):
    try:
        base = tuning.load_tuning(args.tuning) if args.tuning else {}
        values = tuning.merge(base, _kv(args.set))
        values.setdefault("audio.full_scale_db", args.full_scale_db)
        split = tuning.split_tuning(values)
        chain = _chain(args)
    except (OSError, ValueError, KeyError) as exc:
        return _die(str(exc))
    if split.ignored:
        print(f"note: not used by replay: {', '.join(split.ignored)}", file=sys.stderr)
    quiet_spl = 40.0 if args.quiet_spl is None else args.quiet_spl
    if chain is not None and chain.levels_ref_db is not None and args.full_scale_db != chain.levels_ref_db:
        print(f"note: the levels profile was measured at full scale {chain.levels_ref_db:g}; "
              f"replay uses {args.full_scale_db:g}, so clips are scaled by the difference", file=sys.stderr)
    out = open(args.out, "w", encoding="utf-8") if args.out else None
    frames = open(args.frames, "w", encoding="utf-8") if args.frames else None
    try:
        for path in args.wav:
            name = os.path.basename(path)
            print(f"== {path}")
            print(_chain_line(chain, args.full_scale_db, quiet_spl))
            if path.endswith(".json"):
                try:
                    sc = _scenario(path)
                    run_out = replay.replay_scenario(sc, values, quiet_spl_db=quiet_spl, chain=chain)
                except (OSError, ValueError, scen.ScenarioError, KeyError) as exc:
                    return _die(str(exc))
                events = run_out.events
                _print_events(events)
                _print_score(score.score_run(run_out.windows, events, run_out.span, args.tol, 0.0))
            else:
                on_row = None
                if frames is not None:
                    def on_row(row, name=name):
                        frames.write(json.dumps(dict(row, file=name)) + "\n")
                try:
                    events = replay.replay_file(path, values, args.full_scale_db, args.gain_db, args.channel,
                                                on_row, chain=chain)
                except (FileNotFoundError, ValueError, KeyError) as exc:
                    return _die(str(exc))
                _print_events(events)
            if out is not None:
                for e in events:
                    out.write(json.dumps(dict(e, file=name)) + "\n")
    finally:
        for fh in (out, frames):
            if fh is not None:
                fh.close()
    return 0


def cmd_label(args):
    values = {"gunshot.ratio_db": args.ratio_db}
    try:
        events = replay.replay_file(args.wav, values, args.full_scale_db, 0.0, args.channel, None, comb=False)
    except (FileNotFoundError, ValueError) as exc:
        return _die(str(exc))
    shots = [e for e in events if e["type"] == "SHOT"]
    for e in shots:
        print(f"# {e['t']:.3f} s  peak {e['peak_db']:.1f} dB  rise {e['rise_db']:.1f} dB", file=sys.stderr)
    print(json.dumps([round(e["t"], 3) for e in shots]))
    return 0


# ---- scenarios -------------------------------------------------------------------------------

def _print_summary(summary):
    print(f"run {summary['run_dir']}")
    for source, s in summary["scores"].items():
        t = s["totals"]
        print(f"\n[{source}] cost {s['cost']:.2f}  offset {s['offset_s']:+.3f} s")
        print(f"  gunshot: labels {t['labels']} hits {t['hits']} misses {t['misses']} "
              f"extra {t['extra_shots']} unlabelled {t['unlabelled_shots']}")
        print(f"  drone:   detected {t['drone_detected']}/{t['drone_clips']}"
              f"{' (already on at ' + str(t['drone_already_on']) + ')' if t.get('drone_already_on') else ''}  mean latency {t['drone_mean_latency_s']}  "
              f"mean tail {t['drone_mean_tail_s']} s  f0 {t['drone_f0_hz']} Hz")
        print(f"  quiet:   {t['quiet_min']} min  shots {t['quiet_shots']} "
              f"({t['quiet_shots_per_min']}/min)  false drone on {t['drone_false_on_s']} s")
        for w in s["windows"]:
            print(f"    {w['kind']:<8} #{w['index']:<2} {w['start']:9.2f}-{w['end']:9.2f}  "
                  + (f"hits {w['hits']}/{w['labels']} extra {w['extra']}" if w["kind"] == "gunshot"
                     else f"det {w['detected']} lat {w['latency_s']} tail {w['tail_s']} extra {w['extra']}"))
    print(f"\ndrift ppm {summary['drift_ppm']}")


def _scenario(path):
    return scen.load_scenario(path)


def cmd_run(args):
    try:
        sc = _scenario(args.scenario)
        base = tuning.load_tuning(args.tuning) if args.tuning else {}
        values = tuning.merge(base, _kv(args.set))
        traces = _kv(args.trace)
        summary = run.run_scenario(sc, args.node, args.gateway, values, traces, BENCH_DIR,
                                   max_s=args.max_s, tolerance=args.tol, capture_audio=args.capture)
    except run.RunAborted as exc:
        return _die(f"aborted: {exc}; traces off, paplay stopped", EXIT_ABORTED)
    except (OSError, ValueError, DeviceError, scen.ScenarioError, CommandError) as exc:
        return _die(str(exc))
    _print_summary(summary)
    return 0


def cmd_sweep(args):
    try:
        sc = _scenario(args.scenario)
        vary = sweep.parse_vary(args.vary)
        base = tuning.load_tuning(args.tuning) if args.tuning else {}
        chain = None
        if args.replay:
            chain = _chain(args)
            if chain is not None and chain.noise is not None and args.quiet_spl is not None:
                print("note: --quiet-spl is not used when a noise profile gives the quiet time", file=sys.stderr)
            out_dir, rows = sweep.replay_sweep(sc, vary, base, args.tol,
                                               40.0 if args.quiet_spl is None else args.quiet_spl, chain=chain)
        else:
            if not args.node:
                return _die("sweep needs --replay or at least one --node")
            if any(getattr(args, k) not in (None, False) for k in CHAIN_OPTIONS):
                return _die("--bench, --response, --levels, --noise and --noise-bed apply to --replay only")
            out_dir, rows = sweep.hardware_sweep(sc, args.node, args.gateway, vary, base,
                                                 max_s=args.max_s, tolerance=args.tol)
    except run.RunAborted as exc:
        return _die(f"aborted: {exc}; traces off, paplay stopped", EXIT_ABORTED)
    except (OSError, ValueError, DeviceError, scen.ScenarioError) as exc:
        return _die(str(exc))
    print(sweep.table(rows))
    if args.replay:
        print(f"\n{_chain_line(chain, base.get('audio.full_scale_db', 120.0), 40.0 if args.quiet_spl is None else args.quiet_spl)}")
    print(f"\nresults: {os.path.join(out_dir, 'results.jsonl')}")
    return 0


# ---- argument parsing ------------------------------------------------------------------------

def _chain_options(q):
    g = q.add_argument_group("bench chain (replay and sweep --replay)")
    g.add_argument("--bench", metavar="NODE|DIR",
                   help="the newest response, levels and noise profiles of NODE in data/bench/profiles "
                        "(or of the one node in DIR); explicit options below override a kind")
    g.add_argument("--response", metavar="PROFILE", help="response profile: clips go through the measured chain")
    g.add_argument("--levels", metavar="PROFILE",
                   help="levels profile: clip levels map to dB SPL as measured (0 dBFS = spl_at_0dbfs)")
    g.add_argument("--noise", metavar="PROFILE",
                   help="noise profile: quiet time is the measured room noise instead of 40 dB white noise")
    g.add_argument("--noise-bed", dest="noise_bed", action=argparse.BooleanOptionalAction, default=None,
                   help="add the noise under clips too (default: on when --noise or --bench gives a noise profile)")


def build_parser():
    p = argparse.ArgumentParser(prog="sm", description="SonicMesh node tuning and test tool.")
    sub = p.add_subparsers(dest="cmd", required=True, metavar="command")

    def port_arg(q, required=True):
        q.add_argument("--port", action="append", default=[], required=required,
                       help="serial port of a board, e.g. /dev/ttyACM0 (repeat for several)")

    sub.add_parser("ports", help="list boards with their role and node id").set_defaults(func=cmd_ports)

    q = sub.add_parser("params", help="list parameters (use a prefix to filter)")
    port_arg(q)
    q.add_argument("prefix", nargs="?", default="")
    q.add_argument("--json", action="store_true", help="print one JSON object per board")
    q.set_defaults(func=cmd_params)

    q = sub.add_parser("get", help="read parameters")
    port_arg(q)
    q.add_argument("names", nargs="+")
    q.set_defaults(func=cmd_get)

    q = sub.add_parser("set", help="set parameters in RAM (name=value ...)")
    port_arg(q)
    q.add_argument("assignments", nargs="+", metavar="name=value")
    q.add_argument("--save", action="store_true", help="save to flash afterwards")
    q.set_defaults(func=cmd_set)

    q = sub.add_parser("save", help="save every changed parameter to flash")
    port_arg(q)
    q.set_defaults(func=cmd_save)

    q = sub.add_parser("reset", help="reset one parameter, or all, to default in RAM")
    port_arg(q)
    q.add_argument("name", nargs="?")
    q.set_defaults(func=cmd_reset)

    q = sub.add_parser("apply", help="apply a tuning file (flat JSON object) to boards")
    port_arg(q)
    q.add_argument("tuning")
    q.add_argument("--save", action="store_true")
    q.set_defaults(func=cmd_apply)

    q = sub.add_parser("dump", help="print the non-default values of one board as a tuning file")
    port_arg(q)
    q.set_defaults(func=cmd_dump)

    q = sub.add_parser("trace", help="turn trace streams on and record their lines")
    port_arg(q)
    q.add_argument("streams", nargs="+", metavar="stream=level", help="e.g. comb=1 audio=1")
    q.add_argument("--seconds", type=float, help="stop after this long (default: until Ctrl-C)")
    q.add_argument("--out", help="output JSONL (default data/bench/<stamp>-trace.jsonl)")
    q.set_defaults(func=cmd_trace)

    q = sub.add_parser("capture", help="record a board's audio as the detectors receive it")
    port_arg(q)
    q.add_argument("--seconds", type=float, help="length, up to 600")
    q.add_argument("--stop", action="store_true", help="stop a capture that is running")
    q.add_argument("--out", help="WAV file (default data/bench/<stamp>-capture-<node>.wav)")
    q.add_argument("--play", metavar="clip.wav", help="play this file with paplay while recording")
    q.set_defaults(func=cmd_capture)

    q = sub.add_parser("check", help="replay a run's capture.wav and compare it with the node's events")
    q.add_argument("run_dir", help="a run directory under data/bench")
    q.set_defaults(func=cmd_check)

    q = sub.add_parser("replay", help="run the detectors offline on WAV files or a scenario (.json)")
    q.add_argument("wav", nargs="+", help="WAV files, or scenario files (their whole timeline is replayed and scored)")
    q.add_argument("--tuning", help="tuning file")
    q.add_argument("--set", action="append", metavar="name=value", help="override one value")
    q.add_argument("--full-scale-db", type=float, default=120.0, dest="full_scale_db")
    q.add_argument("--gain-db", type=float, default=0.0, dest="gain_db", help="WAV files only")
    q.add_argument("--channel", type=int, help="channel to use (default: mix to mono); WAV files only")
    q.add_argument("--quiet-spl", type=float, default=None, dest="quiet_spl",
                   help="scenario quiet time, dB SPL white noise (default 40; not used with --noise)")
    q.add_argument("--tol", type=float, default=0.03, help="scenario SHOT match tolerance, seconds")
    q.add_argument("--out", help="events JSONL")
    q.add_argument("--frames", help="per-frame comb and per-block impulse rows, as trace lines")
    _chain_options(q)
    q.set_defaults(func=cmd_replay)

    q = sub.add_parser("label", help="propose gunshot label times with a strict replay")
    q.add_argument("wav")
    q.add_argument("--ratio-db", type=float, default=25.0, dest="ratio_db")
    q.add_argument("--full-scale-db", type=float, default=120.0, dest="full_scale_db")
    q.add_argument("--channel", type=int)
    q.set_defaults(func=cmd_label)

    q = sub.add_parser("run", help="play a scenario through the speakers and record the boards")
    q.add_argument("scenario")
    q.add_argument("--node", action="append", default=[], required=True, help="node port (repeat)")
    q.add_argument("--gateway", help="gateway port")
    q.add_argument("--tuning", help="tuning file to apply to the nodes first")
    q.add_argument("--set", action="append", metavar="name=value")
    q.add_argument("--trace", action="append", metavar="stream=level", help="e.g. comb=1")
    q.add_argument("--max-s", type=float, dest="max_s",
                   help="abort after this many seconds (default: scenario length + 120)")
    q.add_argument("--tol", type=float, default=0.03, help="SHOT match tolerance, seconds")
    q.add_argument("--capture", action="store_true",
                   help="the first node records its audio for the whole run (capture.wav in the run directory)")
    q.set_defaults(func=cmd_run)

    q = sub.add_parser("sweep", help="grid over parameter values, offline or on hardware")
    q.add_argument("scenario")
    q.add_argument("--replay", action="store_true", help="offline (no boards)")
    q.add_argument("--node", action="append", default=[], help="node port for hardware mode (repeat)")
    q.add_argument("--gateway", help="gateway port (hardware mode)")
    q.add_argument("--vary", action="append", required=True, metavar="name=v1,v2,...")
    q.add_argument("--tuning", help="base tuning file")
    q.add_argument("--max-s", type=float, dest="max_s",
                   help="per point, hardware mode: abort after this many seconds (default: length + 120)")
    q.add_argument("--tol", type=float, default=0.03)
    q.add_argument("--quiet-spl", type=float, default=None, dest="quiet_spl",
                   help="replay quiet noise, dB SPL white noise (default 40; not used with --noise)")
    _chain_options(q)
    q.set_defaults(func=cmd_sweep)

    if measure is not None:
        measure.add_parser(sub)
    for extra in (deploy, rangetest, tones):
        if extra is not None:
            extra.add_parser(sub)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return _die("interrupted", 130)
