import { MicAnalysis, TILE_COLS, TILE_ROWS } from '../audio/analysis';
import type { AudioRing } from '../acoustics/history';
import type { NodeKind } from '../sim/scenario';
import { esc, need } from './dom';

// Tiles are at least this wide on screen; the grid fits as many per row as the strip allows.
export const TILE_MIN_PX = 120;
const TILE_GAP_PX = 8;

export interface GridLayout {
  cols: number;
  rows: number;
}

// Columns and rows for `count` tiles in a strip `width` px wide. At least one column, and at least the tile minimum
// per column, so the layout scales up from about 800 px wide.
export function tileGrid(count: number, width: number): GridLayout {
  if (count <= 0) return { cols: 1, rows: 0 };
  const fit = Math.floor((width + TILE_GAP_PX) / (TILE_MIN_PX + TILE_GAP_PX));
  const cols = Math.max(1, Math.min(count, fit));
  return { cols, rows: Math.ceil(count / cols) };
}

// What a tile shows about its node. mic is the first mic, the one the tile listens to.
export interface StripNode {
  id: number;
  kind: NodeKind;
  mic: string;
  detecting: boolean;
}

interface Tile {
  button: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  level: HTMLElement;
}

// One small scrolling waterfall per node, all fed from the audio rings. The strip owns only the analysis; it draws
// nothing while it is closed, and clear() drops the analysis so reopening catches up from the rings.
export class WaterfallStrip {
  private readonly grid: HTMLElement;
  private readonly tiles = new Map<number, Tile>();
  private readonly analyses = new Map<string, MicAnalysis>();
  private key = '';
  private count = 0;

  constructor(
    root: HTMLElement,
    badge: string,
    private readonly onSelect: (id: number) => void,
  ) {
    root.innerHTML = `
      <div class="wf-head">
        <h3>Waterfalls</h3>
        ${badge}
        <div class="scale"><span>10 dB</span><span class="ramp"></span><span>90 dB</span></div>
      </div>
      <div class="wf-grid"></div>
      <p class="note">One tile per node, first mic. The last 6 s, same FFT, dB scale and colours as the Waterfall tab. A red edge means the node is detecting. Click a tile to open that node.</p>`;
    this.grid = need<HTMLElement>(root, '.wf-grid');
    new ResizeObserver(() => this.layout()).observe(this.grid);
  }

  // Draws every tile. Rebuilds the tiles when the node list changes.
  update(nodes: StripNode[], selected: number | null, ringFor: (key: string) => AudioRing | undefined): void {
    const key = nodes.map((n) => `${n.id}.${n.kind}.${n.mic}`).join(',');
    if (key !== this.key) this.rebuild(nodes, key);
    const live = new Set<string>();
    for (const n of nodes) {
      const tile = this.tiles.get(n.id);
      if (!tile) continue;
      tile.button.classList.toggle('detecting', n.detecting);
      tile.button.setAttribute('aria-pressed', String(selected === n.id));
      const ring = ringFor(n.mic);
      if (!ring) {
        tile.level.textContent = 'no audio';
        continue;
      }
      live.add(n.mic);
      let an = this.analyses.get(n.mic);
      if (!an) {
        an = new MicAnalysis(n.mic);
        this.analyses.set(n.mic, an);
      }
      an.update(ring, null);
      an.drawStrip(tile.canvas);
      const db = an.latestBandDb();
      tile.level.textContent = db === null ? '—' : `${db.toFixed(0)} dB`;
    }
    for (const mic of this.analyses.keys()) if (!live.has(mic)) this.analyses.delete(mic);
  }

  clear(): void {
    this.analyses.clear();
  }

  private rebuild(nodes: StripNode[], key: string): void {
    this.key = key;
    this.tiles.clear();
    this.grid.replaceChildren();
    for (const n of nodes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wf-tile';
      button.innerHTML = `<span class="wf-name">Node ${n.id}, ${esc(n.kind)}</span><canvas width="${TILE_COLS}" height="${TILE_ROWS}" aria-label="Node ${n.id} waterfall"></canvas><span class="wf-level"></span>`;
      button.addEventListener('click', () => this.onSelect(n.id));
      this.grid.append(button);
      this.tiles.set(n.id, {
        button,
        canvas: need<HTMLCanvasElement>(button, 'canvas'),
        level: need<HTMLElement>(button, '.wf-level'),
      });
    }
    this.count = nodes.length;
    this.layout();
  }

  private layout(): void {
    const { cols } = tileGrid(this.count, this.grid.clientWidth);
    this.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  }
}
