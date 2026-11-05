import { CLASS_ACOUSTICS } from '../acoustics/model';
import type { LoraView, MessageView, PacketView } from '../lora/types';
import { HEALTH_FIELDS, type Message } from '../protocol';
import { COMPONENT } from '../provenance/components';
import type { Ledger } from '../provenance/ledger';
import type { Selection } from '../selection';
import type { NodeSpec, PathSpec } from '../sim/scenario';
import { DRONE_CLASSES, type DroneState, type World } from '../sim/world';
import { badgeHtml, esc, fmt } from './dom';

// `key` is the structure of the panel. The DOM is rebuilt only when it changes, so open dropdowns stay open.
// `live` holds values that change every tick and are written in place.
export interface Panel {
  key: string;
  html: string;
  live: Record<string, string>;
}

export type InspectTab = 'details' | 'waterfall' | 'messages' | 'health' | 'ranging';
export type MessageFilter = 'all' | 'sent' | 'received';

// Node waterfall state, owned by the app. The panel only shows it.
export interface InspectView {
  tab: InspectTab;
  mic: string | null;
  listening: string | null;
  gain: number;
  overlay: boolean;
  truth: boolean;
  ambientLabel: string;
  listenNote: string;
  msgFilter: MessageFilter;
}

export interface InspectContext {
  world: World;
  selection: Selection;
  ledger: Ledger;
  view: InspectView;
  lora: LoraView | null;
}

export type ActionData = Record<string, string | undefined>;

const TAB_LABEL: Record<InspectTab, string> = {
  details: 'Details',
  waterfall: 'Waterfall',
  messages: 'Messages',
  health: 'Health',
  ranging: 'Ranging',
};

function live(name: string): string {
  return `<span data-live="${name}"></span>`;
}

function rows(pairs: [string, string][]): string {
  return pairs
    .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`)
    .join('');
}

function pathLabel(path: PathSpec): string {
  switch (path.kind) {
    case 'manual':
      return 'Hand-flown';
    case 'hover':
      return 'Hover at a point';
    case 'crossing':
      return `Crossing at ${fmt(path.speed_mps)} m/s`;
    case 'out_and_back':
      return `Out and back at ${fmt(path.speed_mps)} m/s`;
    case 'terrain_follow':
      return `Terrain-following at ${fmt(path.speed_mps)} m/s`;
  }
}

// Mic keys of a node, as the engine names them: node id and mic index.
export function micKeysOf(n: NodeSpec): string[] {
  const count = n.kind === 'array' ? 4 : 1;
  return Array.from({ length: count }, (_, j) => `${n.id}.${j}`);
}

function messageFields(msg: Message): [string, string][] {
  switch (msg.type) {
    case 'BEACON':
      return [
        ['Counter', String(msg.counter)],
        ['GNSS time', `${msg.gnssMs} ms`],
        ['Mode', msg.mode === 0 ? 'idle' : 'event'],
        ['Next PHY', `SF${msg.nextPhy.sf}/${msg.nextPhy.bw / 1000} kHz`],
        ['Slots', `${msg.slotMap.length} assigned`],
        ['Track', msg.track ? `drone ${msg.track.id}, ${fmt(msg.track.x)}, ${fmt(msg.track.y)}, ${fmt(msg.track.z)} m` : 'none'],
        ['Snippets', msg.snippets.map((s) => `node ${s.node} req ${s.requestId}`).join(', ') || 'none'],
        ['Commands', msg.commands.map((c) => `${c.id}:${c.arg}`).join(', ') || 'none'],
      ];
    case 'DETECT_START':
      return [
        ['Confidence', `${msg.confidence}/15`],
        ['Band level', `${msg.level} dB`],
        ['Class', String(msg.cls)],
        ['Bearing', `${msg.az}°, ${msg.el}°`],
        ['Strongest line', `${msg.lineHz} Hz`],
      ];
    case 'DETECT':
      return [
        ['Confidence', `${msg.confidence}/15`],
        ['Band level', `${msg.level} dB`],
        ['Bearing', `${msg.az}°, ${msg.el}° (±${msg.bearingSigma}°)`],
        ['Line 1', `${msg.line1Hz} Hz`],
        ['Line 2 delta', `${msg.line2Delta}`],
        ['Class', String(msg.cls)],
        ['Clip ready', msg.clipReady ? 'yes' : 'no'],
      ];
    case 'SNIPPET':
      return [
        ['Request', String(msg.requestId)],
        ['Chunk', `${msg.chunk + 1}/${msg.chunks}`],
        ['Start sample', String(msg.startSample)],
        ['Data', `${msg.data.length} bits, ${msg.data.length / 4000} s at 4 kS/s`],
      ];
    case 'HEALTH':
      return HEALTH_FIELDS.map((f, i) => [f.name, `${msg.fields[i] ?? 0} (${f.provenance})`]);
    case 'RANGING_RESULT':
      return msg.results.map((r) => [`Node ${r.id}`, `${(r.rangeDm / 10).toFixed(1)} m, RSSI ${r.rssi}, SNR ${r.snr}`]);
    case 'JOIN':
      return [
        ['Latitude', `${msg.lat / 1e7}°`],
        ['Longitude', `${msg.lon / 1e7}°`],
        ['Altitude', `${msg.altDm / 10} m`],
        ['Accuracy', `${msg.accuracyDm / 10} m`],
        ['Confident', msg.confident ? 'yes' : 'no'],
        ['Node type', String(msg.nodeType)],
        ['Provisioning', `seq ${msg.provSeq}, time ${msg.provTime}, mac ${msg.provMac.toString(16)}`],
      ];
    case 'ACK':
      return [
        ['Command', String(msg.commandId)],
        ['Result', String(msg.result)],
      ];
  }
}

// Payload bit spans in encoder order, used to colour the hex dump by field.
function payloadSpans(msg: Message): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  let at = 0;
  const push = (name: string, bits: number): void => {
    out.push({ name, start: at, end: at + bits });
    at += bits;
  };
  switch (msg.type) {
    case 'BEACON':
      push('counter', 32);
      push('gnss', 40);
      push('mode', 1);
      push('phy', 4);
      push('slot count', 6);
      msg.slotMap.forEach((_s, i) => push(`slot ${i + 1}`, 16));
      push('track flag', 1);
      if (msg.track) push('track state', 88);
      push('snippet count', 3);
      msg.snippets.forEach((_, i) => push(`snippet request ${i + 1}`, 56));
      push('command count', 4);
      msg.commands.forEach((_, i) => push(`command ${i + 1}`, 16));
      break;
    case 'DETECT_START':
      push('confidence', 4);
      push('level', 6);
      push('class', 3);
      push('azimuth', 9);
      push('elevation', 5);
      push('line', 11);
      break;
    case 'DETECT':
      push('confidence', 4);
      push('level', 6);
      push('azimuth', 9);
      push('elevation', 5);
      push('bearing sigma', 4);
      push('line 1', 11);
      push('line 2 delta', 6);
      push('class', 3);
      push('clip ready', 1);
      push('reserved', 7);
      break;
    case 'SNIPPET':
      push('request', 8);
      push('chunk', 4);
      push('chunks', 4);
      push('start sample', 32);
      push('data', msg.data.length);
      break;
    case 'HEALTH':
      HEALTH_FIELDS.forEach((f) => push(f.key, f.bits));
      break;
    case 'RANGING_RESULT':
      push('count', 4);
      msg.results.forEach((r) => {
        push(`node ${r.id}`, 8);
        push('range', 16);
        push('rssi', 8);
        push('snr', 8);
      });
      break;
    case 'JOIN':
      push('lat', 32);
      push('lon', 32);
      push('alt', 16);
      push('accuracy', 8);
      push('confident', 1);
      push('node type', 2);
      push('prov seq', 8);
      push('prov time', 40);
      push('prov mac', 32);
      break;
    case 'ACK':
      push('command', 8);
      push('result', 8);
      break;
  }
  return out;
}

function hexDump(packet: PacketView): string {
  const bytes = packet.frameHex;
  const labels: string[] = new Array(bytes.length).fill('');
  const assign = (from: number, to: number, label: string): void => {
    for (let i = Math.max(0, from); i < Math.min(bytes.length, to); i++) {
      labels[i] = labels[i] ? `${labels[i]}/${label}` : label;
    }
  };
  assign(0, 1, 'hdr');
  assign(1, 2, 'src');
  assign(2, 3, 'ctr');
  for (const span of payloadSpans(packet.message)) {
    assign(3 + Math.floor(span.start / 8), 3 + Math.ceil(span.end / 8), span.name);
  }
  assign(bytes.length - 4, bytes.length, 'mic');
  const cells = bytes.map((b, i) => {
    const label = labels[i];
    const kind = label === 'hdr' ? 'hdr' : label === 'src' ? 'src' : label === 'ctr' ? 'ctr' : label === 'mic' ? 'mic' : 'field';
    return `<span class="hex-byte hex-${kind}" title="${esc(label || 'byte')}">${b}</span>`;
  });
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += 16) {
    lines.push(`<div class="hex-row"><span class="hex-off">${(i).toString(16).padStart(2, '0')}</span>${cells.slice(i, i + 16).join('')}</div>`);
  }
  return lines.join('');
}

function packetPanel(ctx: InspectContext, id: number): Panel {
  const packet = ctx.lora?.packets.find((p) => p.id === id);
  if (!packet) {
    return {
      key: `packet|${id}|missing`,
      html: `<h2>Packet ${id}</h2><p class="note">This packet is outside the retained history. Pick a block on the timeline.</p>`,
      live: {},
    };
  }
  const fields = messageFields(packet.message)
    .map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join('');
  const rx = packet.rx
    .map((r) => `<tr><td>${r.id === 0 ? 'Gateway' : `Node ${r.id}`}</td><td>${esc(r.fate)}</td><td>${Number.isFinite(r.rssi) ? r.rssi.toFixed(1) : '—'}</td><td>${Number.isFinite(r.snr) ? r.snr.toFixed(1) : '—'}</td><td>${esc(r.reason)}</td></tr>`)
    .join('');
  const tags = [COMPONENT.loraCodec, COMPONENT.loraAirtime, COMPONENT.loraMac].map((c) => badgeHtml(ctx.ledger.byId.get(c))).join('');
  return {
    key: `packet|${packet.id}`,
    html: `
      <h2>Packet ${packet.id} · ${esc(packet.type)}</h2>
      <div class="badges">${tags}</div>
      ${rows([
        ['Transmitter', packet.tx === 0 ? 'Gateway' : `Node ${packet.tx}`],
        ['Channel', esc(packet.channel)],
        ['PHY', `SF${packet.sf}, ${packet.bw / 1000} kHz`],
        ['Slot', esc(packet.slot)],
        ['Start', `${packet.startS.toFixed(3)} s`],
        ['Airtime', `${(packet.airtimeS * 1000).toFixed(1)} ms`],
        ['Payload', `${packet.payloadBytes} B`],
      ])}
      <h3>Raw frame</h3>
      <div class="hex">${hexDump(packet)}</div>
      <p class="note">Header, source, counter and MIC are marked; payload bytes are coloured by field.</p>
      <h3>Decoded fields</h3>
      ${fields}
      <h3>Receivers</h3>
      <table class="data-table"><thead><tr><th>Receiver</th><th>Fate</th><th>RSSI dBm</th><th>SNR dB</th><th>Reason</th></tr></thead><tbody>${rx}</tbody></table>
    `,
    live: {},
  };
}

function messagesNode(ctx: InspectContext, n: NodeSpec): Panel {
  const view = ctx.lora?.nodes.find((o) => o.id === n.id);
  const all = view?.messages ?? [];
  const filter = ctx.view.msgFilter;
  const list = all.filter((m) => filter === 'all' || m.dir === filter).slice(-40).reverse();
  const row = (m: MessageView): string =>
    `<tr><td>${m.t.toFixed(2)}</td><td>${esc(m.dir)}</td><td>${esc(m.type)}</td><td>${m.peer === 0 ? 'GW' : m.peer}</td><td class="mono">${m.frameHex.slice(0, 8).join(' ')}${m.frameHex.length > 8 ? ' …' : ''}</td></tr>`;
  const tags = [COMPONENT.loraCodec, COMPONENT.loraMac, COMPONENT.loraNodeStub].map((c) => badgeHtml(ctx.ledger.byId.get(c))).join('');
  return {
    key: `messages|${n.id}|${filter}|${all.length}|${all.at(-1)?.id ?? 0}`,
    html: `
      <h2>Node ${n.id}, messages</h2>
      <div class="badges">${tags}</div>
      <div class="actions">
        ${(['all', 'sent', 'received'] as const).map((f) => `<button data-action="msg-filter" data-value="${f}" aria-pressed="${filter === f}">${f}</button>`).join('')}
      </div>
      <p class="note">Every frame this node sent or decoded. The stub reports detections; the frames and schedule are v0.</p>
      <table class="data-table"><thead><tr><th>t s</th><th>Dir</th><th>Type</th><th>Peer</th><th>Frame</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>
    `,
    live: {},
  };
}

function healthNode(ctx: InspectContext, n: NodeSpec): Panel {
  const view = ctx.lora?.nodes.find((o) => o.id === n.id);
  const health = view?.health;
  const tags = [COMPONENT.healthReport, COMPONENT.energyModel].map((c) => badgeHtml(ctx.ledger.byId.get(c))).join('');
  if (!health) {
    return {
      key: `health|${n.id}|none`,
      html: `<h2>Node ${n.id}, health</h2><div class="badges">${tags}</div><p class="note">No HEALTH report decoded yet. Each node reports every 75 idle superframes.</p>`,
      live: {},
    };
  }
  const rowsHtml = health.values
    .map(
      (v) =>
        `<tr><td>${esc(v.name)}</td><td>${v.bits}</td><td class="mono">${v.raw}</td><td>${fmt(v.value)} ${esc(v.unit)}</td><td><span class="tag tag-${v.provenance.toLowerCase()}">${esc(v.provenance)}</span></td></tr>`,
    )
    .join('');
  return {
    key: `health|${n.id}|${health.atS}`,
    html: `
      <h2>Node ${n.id}, health</h2>
      <div class="badges">${tags}</div>
      <p class="note">HEALTH at ${health.atS.toFixed(2)} s, 152 bits in HEALTH_FIELDS order. MODELLED fields come from sim state; ASSUMED fields use the simple battery, solar and clock models.</p>
      <table class="data-table"><thead><tr><th>Field</th><th>Bits</th><th>Raw</th><th>Value</th><th>Source</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    `,
    live: {},
  };
}

function rangingNode(ctx: InspectContext, n: NodeSpec): Panel {
  const view = ctx.lora?.nodes.find((o) => o.id === n.id);
  const list = [...(view?.ranging ?? [])].reverse();
  const tags = [COMPONENT.ranging, COMPONENT.loraAirtime].map((c) => badgeHtml(ctx.ledger.byId.get(c))).join('');
  const rowsHtml = list
    .map(
      (r) =>
        `<tr><td>${r.atS.toFixed(2)}</td><td>${r.peer}</td><td>${r.measuredM.toFixed(1)}</td><td>${r.trueM.toFixed(1)}</td><td>${(r.measuredM - r.trueM).toFixed(1)}</td><td>${r.rssi.toFixed(1)}</td><td>${r.snr.toFixed(1)}</td></tr>`,
    )
    .join('');
  return {
    key: `ranging|${n.id}|${list.length}|${list[0]?.atS ?? 0}`,
    html: `
      <h2>Node ${n.id}, ranging</h2>
      <div class="badges">${tags}</div>
      <p class="note">RTToF results in idle slots, true distance plus N(0, 4 m) and a static NLOS bias (p 0.25, up to 12 m). Ranging never runs in event mode.</p>
      <table class="data-table"><thead><tr><th>t s</th><th>Peer</th><th>Measured m</th><th>True m</th><th>Error m</th><th>RSSI</th><th>SNR</th></tr></thead><tbody>${rowsHtml || '<tr><td colspan="7">No sweep yet.</td></tr>'}</tbody></table>
    `,
    live: {},
  };
}

function healthCell(view: LoraView, id: number): string {
  const h = view.gateway.health.find((x) => x.id === id);
  if (!h || !h.health) return '—';
  const v = h.health.values;
  const battery = v.find((x) => x.key === 'battery')?.value ?? 0;
  const temp = v.find((x) => x.key === 'temperature')?.value ?? 0;
  const det = v.find((x) => x.key === 'detections')?.value ?? 0;
  return `${battery.toFixed(2)} V, ${temp.toFixed(1)} C, ${det.toFixed(0)} det`;
}

function droneTab(ctx: InspectContext, d: DroneState): Panel {
  const { world, ledger } = ctx;
  const tag = (id: string): string => badgeHtml(ledger.byId.get(id));
  const scripted = d.path.kind !== 'manual';
  const classOptions = Object.entries(DRONE_CLASSES)
    .map(([k, v]) => `<option value="${k}"${k === d.class ? ' selected' : ''}>${esc(v.label)}</option>`)
    .join('');
  const flightButton = (mode: 'manual' | 'gps', label: string): string =>
    `<button data-action="drone-flight" data-id="${d.id}" data-value="${mode}" aria-pressed="${d.flight === mode}">${label}</button>`;
  const pathButton = (kind: string, label: string): string =>
    `<button data-action="drone-path" data-id="${d.id}" data-value="${kind}" aria-pressed="${d.path.kind === kind}">${label}</button>`;
  const alt = d.alt;
  const agl = alt - world.terrain.height(d.x, d.y);
  const bpf = CLASS_ACOUSTICS[d.class].bpf_hz;
  return {
    key: `drone|${d.id}|${d.class}|${d.flight}|${d.path.kind}`,
    html: `
      <h2>Drone ${d.id}</h2>
      <div class="badges">${tag(COMPONENT.droneDynamics)}${tag(COMPONENT.droneClasses)}${scripted ? tag(COMPONENT.dronePaths) : ''}${tag(COMPONENT.droneRotors)}</div>
      ${rows([
        ['Class', `<select data-action="drone-class" data-id="${d.id}" aria-label="Drone class">${classOptions}</select>`],
        ['Path', esc(pathLabel(d.path))],
        ['True position', live('d-pos')],
        ['Speed', live('d-speed')],
        ['Vertical speed', live('d-vspeed')],
        ['Altitude', live('d-alt')],
      ])}
      <h3>Flight</h3>
      <div class="actions">${flightButton('manual', 'Manual')}${flightButton('gps', 'GPS hover')}</div>
      <p class="note">${
        scripted
          ? 'On a scripted path. Moving the sticks takes manual control.'
          : 'Manual: sticks give acceleration and keep momentum. GPS hover: sticks give speed and the drone stops when they are centred.'
      }</p>
      <h3>Path</h3>
      <div class="actions">
        ${pathButton('manual', 'Hand-fly')}
        ${pathButton('hover', 'Hover here')}
        ${pathButton('crossing', 'Crossing 20 m/s')}
        ${pathButton('out_and_back', 'Out and back')}
        ${pathButton('terrain_follow', 'Terrain-follow')}
      </div>
      <p class="note">Drawn at an exaggerated size so it is visible at map scale.</p>
      <h3>Rotor speeds</h3>
      <canvas class="plot" data-plot="rotors" width="300" height="150" aria-label="Rotor blade-pass frequencies over the last 5 s"></canvas>
      <p class="note">Emitted blade-pass frequency of each rotor over the last 5 s, from thrust and wobble. Hover gives ${bpf} Hz for this class (ASSUMED).</p>
      <h3>Emitted spectrum</h3>
      <canvas class="plot" data-plot="spectrum" width="300" height="150" aria-label="Emitted spectrum at 1 m"></canvas>
      <p class="note">The synthetic source at 1 m, dB SPL per bin, 0 to 4 kHz.</p>
      <div class="actions"><button data-action="drone-remove" data-id="${d.id}">Remove drone</button></div>
    `,
    live: {
      'd-pos': `${fmt(d.x)}, ${fmt(d.y)} m`,
      'd-speed': `${fmt(Math.hypot(d.vx, d.vy))} m/s`,
      'd-vspeed': `${fmt(d.vz)} m/s`,
      'd-alt': `${fmt(alt)} m above datum, ${fmt(agl)} m above ground`,
    },
  };
}

function detailsNode(ctx: InspectContext, n: NodeSpec): Panel {
  const { world, ledger } = ctx;
  const isArray = n.kind === 'array';
  const other = isArray ? 'detector' : 'array';
  return {
    key: `node|${n.id}|${n.kind}`,
    html: `
      <h2>Node ${n.id}</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(isArray ? COMPONENT.nodeArray : COMPONENT.nodeDetector))}${badgeHtml(ledger.byId.get(COMPONENT.mic))}${badgeHtml(ledger.byId.get(COMPONENT.loraNodeStub))}</div>
      ${rows([
        ['Type', isArray ? 'Array, 4 mics' : 'Detector, 1 mic'],
        ['True position', live('n-pos')],
        ['Ground', live('n-ground')],
      ])}
      <div class="actions">
        <button data-action="node-kind" data-id="${n.id}" data-value="${other}">Make ${other}</button>
        <button data-action="node-remove" data-id="${n.id}">Remove node</button>
      </div>
      <p class="note">Open the Waterfall tab for the mic audio, band level and listen mode; Messages, Health and Ranging show the v0 link. Detections here come from the clearly labelled stub until the node core lands in M2.</p>
    `,
    live: {
      'n-pos': `${fmt(n.x)}, ${fmt(n.y)} m`,
      'n-ground': `${fmt(world.terrain.height(n.x, n.y))} m`,
    },
  };
}

function waterfallNode(ctx: InspectContext, n: NodeSpec): Panel {
  const { ledger, view } = ctx;
  const isArray = n.kind === 'array';
  const mics = micKeysOf(n);
  const mic = view.mic && mics.includes(view.mic) ? view.mic : mics[0];
  const listening = view.listening === mic;
  const options = mics
    .map((k, j) => `<option value="${k}"${k === mic ? ' selected' : ''}>Mic ${j + 1} (${k})</option>`)
    .join('');
  const truthOn = view.truth;
  const overlayOn = truthOn && view.overlay;
  return {
    key: `waterfall|${n.id}|${n.kind}|${mic}|${listening}|${overlayOn}|${truthOn}|${view.ambientLabel}`,
    html: `
      <h2>Node ${n.id}, waterfall</h2>
      <div class="badges">${badgeHtml(ledger.byId.get(isArray ? COMPONENT.nodeArray : COMPONENT.nodeDetector))}${badgeHtml(ledger.byId.get(COMPONENT.waterfall))}</div>
      <div class="actions"><select data-action="mic-select" data-id="${n.id}" aria-label="Mic">${options}</select></div>
      <canvas class="plot wf" data-plot="waterfall" width="300" height="512" aria-label="Mic spectrogram, 0 to 8 kHz"></canvas>
      <div class="scale"><span>10 dB</span><span class="ramp"></span><span>90 dB</span></div>
      <p class="note">dB SPL per bin, as the line level of a sine in that bin. 1024-point Hann FFT, 50 % overlap, 0 to 8 kHz, newest on the right.</p>
      <div class="actions"><button data-action="overlay" data-id="${n.id}" aria-pressed="${overlayOn}"${truthOn ? '' : ' disabled'}>Truth: blade-pass harmonics</button></div>
      <p class="note">${
        truthOn
          ? 'White dots: the true blade-pass harmonics of each rotor at this mic, from the emitted rotor speed and the Doppler delay.'
          : 'Turn truth on (T) to show the true blade-pass harmonics.'
      }</p>
      <h3>Band level and SNR</h3>
      <canvas class="plot" data-plot="level" width="300" height="150" aria-label="Band level and SNR over time"></canvas>
      <p class="note">Band 100 to 4000 Hz per 100 ms. SNR is that band minus the ambient setting (${esc(view.ambientLabel)}), so with no drone it sits near 0 dB.</p>
      <h3>Listen</h3>
      <div class="actions"><button data-action="listen" data-value="${mic}" aria-pressed="${listening}">${listening ? 'Stop listening' : 'Listen to this mic'}</button></div>
      <label class="gain">Gain <input type="range" min="0" max="2" step="0.05" value="${view.gain}" data-action="listen-gain" aria-label="Listen gain"></label>
      <p class="note">${live('listen-note')}</p>
    `,
    live: { 'listen-note': view.listenNote },
  };
}

function gatewayTab(ctx: InspectContext): Panel {
  const { world, ledger, lora } = ctx;
  const g = world.state.gateway;
  const tags = [COMPONENT.gateway, COMPONENT.loraMac, COMPONENT.loraAirtime].map((c) => badgeHtml(ledger.byId.get(c))).join('');
  if (!lora) {
    return {
      key: 'gateway|none',
      html: `<h2>Gateway</h2><div class="badges">${tags}</div>${rows([['True position', live('g-pos')]])}<p class="note">Waiting for the first LoRa superframe.</p>`,
      live: { 'g-pos': `${fmt(g.x)}, ${fmt(g.y)} m` },
    };
  }
  const healthRows = lora.nodes
    .map((n) => `<tr><td>${n.id}</td><td>${esc(n.kind)}</td><td>${n.health ? n.health.atS.toFixed(1) : '—'}</td><td>${healthCell(lora, n.id)}</td><td>${n.silent ? 'silent' : 'ok'}</td></tr>`)
    .join('');
  const dutyRows = lora.gateway.duty
    .map((d) => `<tr><td>${esc(d.channel)}</td><td>${(d.duty * 100).toFixed(2)} %</td><td>${d.seconds.toFixed(1)} s</td></tr>`)
    .join('');
  return {
    key: `gateway|${lora.mode}|${lora.superframe}|${lora.nodes.length}|${lora.gateway.health.map((h) => h.lastHealthS ?? 0).join(',')}`,
    html: `
      <h2>Gateway</h2>
      <div class="badges">${tags}</div>
      ${rows([
        ['True position', live('g-pos')],
        ['Mode', esc(lora.mode)],
        ['Superframe', String(lora.superframe)],
        ['Last detection', Number.isFinite(lora.eventLastS) ? `${lora.eventLastS.toFixed(2)} s` : 'none'],
        ['Beacon duty', `${(lora.gateway.beaconDuty * 100).toFixed(2)} %`],
      ])}
      <p class="note">Drag it on the ground to move it. The gateway owns time: one beacon per superframe, idle or event. Fusion of detections arrives in M4.</p>
      <h3>Health dashboard</h3>
      <table class="data-table"><thead><tr><th>Node</th><th>Kind</th><th>Report t</th><th>Latest</th><th>State</th></tr></thead><tbody>${healthRows}</tbody></table>
      <h3>Silent nodes</h3>
      <p class="note">${lora.gateway.silent.length === 0 ? 'None: every node has reported within two health periods.' : `No report for more than two periods (event time excluded): ${lora.gateway.silent.join(', ')}.`}</p>
      <h3>Duty cycle per channel</h3>
      <table class="data-table"><thead><tr><th>Channel</th><th>Duty</th><th>Busy</th></tr></thead><tbody>${dutyRows}</tbody></table>
    `,
    live: { 'g-pos': `${fmt(g.x)}, ${fmt(g.y)} m` },
  };
}

function sceneTab(ctx: InspectContext): Panel {
  const { world, ledger } = ctx;
  const s = world.state;
  const t = world.terrain;
  const tags = [COMPONENT.terrain, COMPONENT.road, COMPONENT.trees]
    .map((id) => badgeHtml(ledger.byId.get(id)))
    .join('');
  return {
    key: `scene|${world.name}|${s.truth}|${s.nodes.length}|${s.drones.length}`,
    html: `
      <h2>${esc(world.name)}</h2>
      <div class="badges">${tags}</div>
      ${rows([
        ['Seed', String(t.seed)],
        ['Terrain', `${t.size[0] / 1000} x ${t.size[1] / 1000} km`],
        ['Nodes', `${s.nodes.length}`],
        ['Drones', `${s.drones.length}`],
        ['Truth overlay', s.truth ? 'on' : 'off'],
        ['Sim time', live('s-time')],
      ])}
      <p class="note">Click a node, drone, or the gateway to inspect it. Drag nodes and the gateway on the ground. Click the ground to add when a + button is active.</p>
    `,
    live: { 's-time': `${fmt(s.tick * 0.01, 2)} s, tick ${s.tick}` },
  };
}

function detailsPanel(ctx: InspectContext): Panel {
  const sel = ctx.selection;
  if (sel?.kind === 'packet') return packetPanel(ctx, sel.id);
  if (sel?.kind === 'node') {
    const n = ctx.world.state.nodes.find((o) => o.id === sel.id);
    if (n) return detailsNode(ctx, n);
  }
  if (sel?.kind === 'drone') {
    const d = ctx.world.state.drones.find((o) => o.id === sel.id);
    if (d) return droneTab(ctx, d);
  }
  if (sel?.kind === 'gateway') return gatewayTab(ctx);
  return sceneTab(ctx);
}

function selectionId(s: Selection): number | undefined {
  return s && 'id' in s ? s.id : undefined;
}

// Lets the user select gateway, nodes and drones without the 3D view. This is the side panel's only content.
export function objectList(ctx: InspectContext): Panel {
  const { world, selection } = ctx;
  const s = world.state;
  const items: { kind: string; id?: number; label: string }[] = [
    { kind: 'gateway', label: 'Gateway' },
    ...s.nodes.map((n) => ({ kind: 'node', id: n.id, label: `Node ${n.id}, ${n.kind}` })),
    ...s.drones.map((d) => ({ kind: 'drone', id: d.id, label: `Drone ${d.id}, ${DRONE_CLASSES[d.class].label}` })),
  ];
  const buttons = items
    .map((it) => {
      const on = selection?.kind === it.kind && selectionId(selection) === it.id;
      const idAttr = it.id === undefined ? '' : ` data-id="${it.id}"`;
      return `<button data-action="select" data-kind="${it.kind}"${idAttr} aria-pressed="${on}">${esc(it.label)}</button>`;
    })
    .join('');
  const current = `${selection?.kind ?? ''}:${selectionId(selection) ?? ''}`;
  return {
    key: `objects|${items.map((it) => `${it.kind}${it.id ?? ''}${it.label}`).join(',')}|${current}`,
    html: `<h3>Objects</h3><div class="object-list">${buttons}</div>`,
    live: {},
  };
}

// The tabbed content of the selected object, for the pop-up window. Tabs are listed per object kind here, so a new
// tab only touches this file.
export function buildPanel(ctx: InspectContext): Panel {
  const sel = ctx.selection;
  const tabs: InspectTab[] = sel?.kind === 'node' ? ['details', 'waterfall', 'messages', 'health', 'ranging'] : ['details'];
  const tab: InspectTab = tabs.includes(ctx.view.tab) ? ctx.view.tab : 'details';
  let main: Panel | null = null;
  if (sel?.kind === 'node') {
    const n = ctx.world.state.nodes.find((o) => o.id === sel.id);
    if (n) {
      if (tab === 'waterfall') main = waterfallNode(ctx, n);
      else if (tab === 'messages') main = messagesNode(ctx, n);
      else if (tab === 'health') main = healthNode(ctx, n);
      else if (tab === 'ranging') main = rangingNode(ctx, n);
    }
  }
  const body = main ?? detailsPanel(ctx);
  const bar =
    tabs.length < 2
      ? ''
      : `<div class="inspector-tabs">${tabs
          .map((t) => `<button data-action="inspector-tab" data-value="${t}" aria-selected="${t === tab}">${TAB_LABEL[t]}</button>`)
          .join('')}</div>`;
  return {
    key: `${tab}|${body.key}`,
    html: bar + body.html,
    live: body.live,
  };
}

// Title for the pop-up window: what the object is.
export function objectTitle(world: World, sel: Selection): string {
  if (sel?.kind === 'node') {
    const n = world.state.nodes.find((o) => o.id === sel.id);
    return n ? `Node ${n.id}, ${n.kind}` : 'Node';
  }
  if (sel?.kind === 'drone') {
    const d = world.state.drones.find((o) => o.id === sel.id);
    return d ? `Drone ${d.id}, ${DRONE_CLASSES[d.class].label}` : 'Drone';
  }
  if (sel?.kind === 'gateway') return 'Gateway';
  if (sel?.kind === 'packet') return `Packet ${sel.id}`;
  return '';
}

// False once a node or drone has been removed (or not yet added, on replay), so its window can close.
export function selectionExists(world: World, sel: Selection): boolean {
  if (sel?.kind === 'node') return world.state.nodes.some((o) => o.id === sel.id);
  if (sel?.kind === 'drone') return world.state.drones.some((o) => o.id === sel.id);
  return true;
}

export class Inspector {
  private key = '';

  constructor(
    private readonly root: HTMLElement,
    onAction: (action: string, data: ActionData) => void,
  ) {
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('button[data-action]');
      if (el?.dataset.action) onAction(el.dataset.action, { ...el.dataset });
    });
    root.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.tagName === 'SELECT' && el.dataset.action) onAction(el.dataset.action, { ...el.dataset, value: el.value });
    });
    root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.type === 'range' && el.dataset.action) onAction(el.dataset.action, { ...el.dataset, value: el.value });
    });
  }

  update(panel: Panel): void {
    if (panel.key !== this.key) {
      this.key = panel.key;
      this.root.innerHTML = panel.html;
    }
    for (const [name, text] of Object.entries(panel.live)) {
      const el = this.root.querySelector<HTMLElement>(`[data-live="${name}"]`);
      if (el && el.textContent !== text) el.textContent = text;
    }
  }
}
