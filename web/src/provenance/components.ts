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
  droneSound: 'drone-sound-interactive',
  sourceLevel: 'source-level',
  droneRotors: 'drone-rotors',
  propagation: 'propagation',
  airAbsorption: 'air-absorption',
  terrainBlocking: 'terrain-blocking',
  ambient: 'ambient-noise',
  mic: 'mic',
  simWorker: 'sim-worker',
  waterfall: 'waterfall',
  bandSnr: 'band-snr',
  truthOverlay: 'truth-overlay',
  listen: 'listen-playback',
} as const;

export const COMPONENT_IDS: string[] = Object.values(COMPONENT);
