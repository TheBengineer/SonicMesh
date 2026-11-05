import { tagClass, type LedgerEntry } from '../provenance/ledger';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v: string | number): string {
  return String(v).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function badgeHtml(entry: LedgerEntry | undefined): string {
  if (!entry) return '';
  return `<span class="badge ${tagClass(entry.tag)}" title="${esc(entry.name)}: ${esc(entry.summary)}">${esc(entry.tag)}</span>`;
}

export function need<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
}

export function fmt(v: number, digits = 1): string {
  return v.toFixed(digits);
}

export function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readJson(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown;
}

// Marks the plot of the mic being played. It dims while the audio is muted.
export const SPEAKER_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 6v4h2.5L8 13V3L4.5 6z"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M10.2 5.6a3.2 3.2 0 0 1 0 4.8M12 3.8a5.6 5.6 0 0 1 0 8.4"/></svg>';
