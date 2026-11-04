// Ledger ids for every component the UI shows a badge for. Tested against provenance.yaml.
export const COMPONENT = {
  terrain: 'terrain',
  road: 'road',
  trees: 'trees',
  nodeDetector: 'node-detector',
  nodeArray: 'node-array',
  gateway: 'gateway',
  radar: 'radar',
  droneDynamics: 'drone-dynamics',
  dronePaths: 'drone-scripted-paths',
  droneClasses: 'drone-classes',
} as const;

export const COMPONENT_IDS: string[] = Object.values(COMPONENT);
