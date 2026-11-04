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
