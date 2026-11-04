import { parse } from 'yaml';
import ledgerText from '../../provenance.yaml?raw';

export const TAGS = ['REAL', 'SAME CODE', 'MODELLED', 'ASSUMED', 'STUB'] as const;
export type Tag = (typeof TAGS)[number];

export interface LedgerEntry {
  id: string;
  name: string;
  tag: Tag;
  milestone: string;
  summary: string;
  evidence: string;
  upgrade: string;
  bias?: string;
}

export interface Ledger {
  entries: LedgerEntry[];
  byId: Map<string, LedgerEntry>;
}

function str(o: Record<string, unknown>, key: string, id: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`ledger ${id}: ${key} must be a non-empty string`);
  return v;
}

export function parseLedger(text: string): Ledger {
  const doc = parse(text) as { components?: unknown } | null;
  if (!doc || !Array.isArray(doc.components)) throw new Error('ledger: expected a components list');
  const entries: LedgerEntry[] = [];
  const byId = new Map<string, LedgerEntry>();
  for (const raw of doc.components as Record<string, unknown>[]) {
    const id = str(raw, 'id', '?');
    if (byId.has(id)) throw new Error(`ledger: duplicate id ${id}`);
    const tag = str(raw, 'tag', id);
    if (!(TAGS as readonly string[]).includes(tag)) throw new Error(`ledger ${id}: unknown tag ${tag}`);
    const entry: LedgerEntry = {
      id,
      name: str(raw, 'name', id),
      tag: tag as Tag,
      milestone: str(raw, 'milestone', id),
      summary: str(raw, 'summary', id),
      evidence: str(raw, 'evidence', id),
      upgrade: str(raw, 'upgrade', id),
    };
    if (raw.bias !== undefined) entry.bias = str(raw, 'bias', id);
    entries.push(entry);
    byId.set(id, entry);
  }
  return { entries, byId };
}

export function loadLedger(): Ledger {
  return parseLedger(ledgerText);
}

export function tagClass(tag: Tag): string {
  return `tag-${tag.toLowerCase().replace(/ /g, '-')}`;
}
