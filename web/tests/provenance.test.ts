import { describe, expect, it } from 'vitest';
import ledgerText from '../provenance.yaml?raw';
import { COMPONENT_IDS } from '../src/provenance/components';
import { TAGS, parseLedger, tagClass } from '../src/provenance/ledger';

const ledger = parseLedger(ledgerText);

describe('provenance ledger', () => {
  it('every entry has a valid tag and the required fields', () => {
    expect(ledger.entries.length).toBeGreaterThan(0);
    for (const e of ledger.entries) {
      expect(TAGS, e.id).toContain(e.tag);
      for (const field of ['name', 'summary', 'evidence', 'upgrade', 'milestone'] as const) {
        expect(e[field].length, `${e.id}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('ids are unique', () => {
    expect(ledger.byId.size).toBe(ledger.entries.length);
  });

  it('every component the UI shows a badge for has a ledger entry', () => {
    for (const id of COMPONENT_IDS) {
      const entry = ledger.byId.get(id);
      expect(entry, id).toBeDefined();
      expect(TAGS).toContain(entry?.tag);
    }
  });

  it('covers the section 4 table of the demo plan', () => {
    for (const id of [
      'drone-sound-interactive',
      'drone-sound-replay',
      'propagation',
      'terrain',
      'trees',
      'wind',
      'turbulence',
      'background',
      'mic',
      'lora-airtime',
      'lora-path-loss',
      'ranging',
      'health-report',
      'energy-model',
      'provisioning-modem',
      'provisioning-channel',
      'mcu-load',
    ]) {
      expect(ledger.byId.has(id), id).toBe(true);
    }
  });

  it('M0 scene components are tagged STUB for acoustics, drone dynamics MODELLED', () => {
    expect(ledger.byId.get('terrain')?.tag).toBe('STUB');
    expect(ledger.byId.get('trees')?.tag).toBe('STUB');
    expect(ledger.byId.get('drone-dynamics')?.tag).toBe('MODELLED');
  });

  it('rejects an unknown tag', () => {
    expect(() => parseLedger('components:\n  - id: x\n    name: X\n    tag: MAYBE\n    milestone: M0\n    summary: s\n    evidence: e\n    upgrade: u\n')).toThrow(/unknown tag/);
  });

  it('maps tags to CSS classes', () => {
    expect(tagClass('SAME CODE')).toBe('tag-same-code');
    expect(tagClass('STUB')).toBe('tag-stub');
  });
});
