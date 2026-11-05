import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Listener } from '../src/audio/listen';
import type { SimHost } from '../src/sim/simHost';

let contexts = 0;
let finishLoading: () => void = () => {};

class FakeContext {
  state = 'running';
  sampleRate = 48000;
  destination = {};
  audioWorklet = { addModule: () => new Promise<void>((done) => (finishLoading = done)) };
  constructor() {
    contexts++;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeNode {
  gain = { value: 0 };
  port = { postMessage: () => {} };
  connect<T>(next: T): T {
    return next;
  }
}

const host = { ring: () => undefined } as unknown as SimHost;

describe('Listener', () => {
  beforeEach(() => {
    contexts = 0;
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    vi.stubGlobal('GainNode', FakeNode);
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stays silent when stopped before the audio has finished loading', async () => {
    const listener = new Listener(host);
    const started = listener.start('4.0');
    listener.stop();
    finishLoading();
    await started;
    expect(listener.key).toBeNull();
  });

  it('plays the last mic asked for, with one audio context, when clicks overlap', async () => {
    const listener = new Listener(host);
    const first = listener.start('4.0');
    const second = listener.start('5.0');
    finishLoading();
    await Promise.all([first, second]);
    expect(listener.key).toBe('5.0');
    expect(contexts).toBe(1);
  });
});
