/**
 * Per-deck Web Audio chain.
 *
 * source → low shelf → mid peak → high shelf → trim/crossfade gain → master.
 * The EQ is real filtering (hardware-style kill at ±24 dB), and the chain is
 * built once per deck so fader moves never rebuild the graph.
 */

export interface EqBand {
  low: number; // dB, -24..+12
  mid: number;
  high: number;
}

export const NEUTRAL_EQ: EqBand = { low: 0, mid: 0, high: 0 };

export interface DeckChain {
  input: AudioNode;
  output: GainNode;
  setEq(band: EqBand): void;
  dispose(): void;
}

export function createDeckChain(ctx: AudioContext, source: MediaElementAudioSourceNode): DeckChain {
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;

  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1200;
  mid.Q.value = 0.8;

  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 5200;

  const output = ctx.createGain();
  source.connect(low).connect(mid).connect(high).connect(output);

  const clamp = (value: number) => Math.min(12, Math.max(-24, value));
  return {
    input: low,
    output,
    setEq(band: EqBand) {
      const t = ctx.currentTime;
      low.gain.setTargetAtTime(clamp(band.low), t, 0.02);
      mid.gain.setTargetAtTime(clamp(band.mid), t, 0.02);
      high.gain.setTargetAtTime(clamp(band.high), t, 0.02);
    },
    dispose() {
      for (const node of [low, mid, high, output]) {
        try {
          node.disconnect();
        } catch {
          // already detached
        }
      }
    },
  };
}
