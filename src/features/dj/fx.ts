/**
 * Per-deck FX send: filter sweep, echo (feedback delay) and reverb.
 *
 * Mixxx-style "beats" FX are overkill here; this is the useful subset — a
 * resonant filter, a tempo-locked echo and a cheap algorithmic reverb, each
 * with its own wet control, wired as a send so the dry signal never stops.
 */

export interface FxState {
  /**
   * 0..1 mapped onto a 40 Hz..18 kHz low-pass sweep. A deck must start open
   * (1); the old neutral was 0.5, i.e. a 3 dB-resonant 850 Hz low-pass, which
   * made every deck sound muffled before a single knob was touched.
   */
  filter: number;
  /** Wet 0..1; delay length is derived from the deck tempo. */
  echo: number;
  /** Feedback 0..0.85. */
  feedback: number;
  /** Wet 0..1. */
  reverb: number;
}

export const NEUTRAL_FX: FxState = { filter: 1, echo: 0, feedback: 0.4, reverb: 0 };

/** Log-scale cutoff for the filter knob. */
export function filterCutoffHz(knob: number): number {
  const t = Math.min(1, Math.max(0, knob));
  return 40 * Math.pow(18_000 / 40, t);
}

/** Echo delay for `beats` beats at the deck tempo. */
export function echoDelayMs(beats: number, bpm: number): number {
  if (bpm <= 0) return 0;
  return Math.max(20, (60_000 / bpm) * beats);
}

export interface DeckFx {
  input: GainNode;
  output: GainNode;
  update(state: FxState, bpm: number): void;
  dispose(): void;
}

function makeImpulse(ctx: AudioContext, seconds = 2.2, decay = 3): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

export function createDeckFx(ctx: AudioContext): DeckFx {
  const input = ctx.createGain();
  const output = ctx.createGain();

  // Dry path is always through the filter, like Mixxx's filter FX.
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 3;
  filter.connect(output);
  input.connect(filter);

  // Echo send.
  const delay = ctx.createDelay(2);
  const feedbackGain = ctx.createGain();
  const echoWet = ctx.createGain();
  echoWet.gain.value = 0;
  input.connect(delay);
  delay.connect(feedbackGain).connect(delay);
  delay.connect(echoWet).connect(output);

  // Reverb send.
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = 0;
  input.connect(convolver).connect(reverbWet).connect(output);

  return {
    input,
    output,
    update(state: FxState, bpm: number) {
      const t = ctx.currentTime;
      filter.frequency.setTargetAtTime(filterCutoffHz(state.filter), t, 0.02);
      echoWet.gain.setTargetAtTime(Math.min(1, Math.max(0, state.echo)), t, 0.02);
      feedbackGain.gain.setTargetAtTime(
        state.echo > 0 ? Math.min(0.85, Math.max(0, state.feedback)) : 0,
        t,
        0.02,
      );
      const delayMs = echoDelayMs(0.5, bpm);
      if (delayMs > 0) delay.delayTime.setTargetAtTime(delayMs / 1000, t, 0.05);
      reverbWet.gain.setTargetAtTime(Math.min(1, Math.max(0, state.reverb)), t, 0.02);
    },
    dispose() {
      for (const node of [filter, delay, feedbackGain, echoWet, convolver, reverbWet, output]) {
        try {
          node.disconnect();
        } catch {
          // already detached
        }
      }
    },
  };
}
