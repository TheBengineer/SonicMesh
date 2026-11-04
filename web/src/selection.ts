export type Selection =
  | { kind: 'node'; id: number }
  | { kind: 'drone'; id: number }
  | { kind: 'gateway' }
  | { kind: 'radar' }
  | { kind: 'packet'; id: number }
  | null;
