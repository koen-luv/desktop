/**
 * Real-time Web Audio Effects Engine for independent pitch control and studio reverb.
 *
 * Pitch Shifting:
 * Uses a 4-tap Hann-windowed granular phase shifter with exact Doppler modulation
 * (s = |1 - 2^(st/12)| * T). Eliminates the comb filtering, 10-Hz motorboating,
 * and brutal metallic phase distortion of primitive 2-tap delay shifters.
 * Automatically switches to 100% bit-perfect dry bypass when pitch is 0 or linked.
 *
 * Reverb:
 * Uses a high-density stereo ConvolverNode with an algorithmic impulse response
 * featuring ~15ms soft rise, decorrelated stereo diffusion, exponential decay,
 * and progressive high-frequency air damping. Filtered with a 120Hz highpass
 * to protect sub-bass/808s.
 * Perfectly tuned for the authentic "Slowed + Reverb" aesthetic.
 */

const GRAIN_PERIOD = 0.038; // 38ms grain window
const NUM_TAPS = 4;

function createHannBuffer(context: AudioContext, period: number): AudioBuffer {
  const length = Math.max(1, Math.floor(period * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const p = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    // Raised cosine / Hann window (0 at boundaries, peak 1 at center)
    p[i] = Math.pow(Math.sin((Math.PI * i) / length), 2);
  }
  return buffer;
}

function createRampBuffer(context: AudioContext, period: number, rampDown: boolean): AudioBuffer {
  const length = Math.max(1, Math.floor(period * context.sampleRate));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const p = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    p[i] = rampDown ? (length - 1 - i) / length : i / length;
  }
  return buffer;
}

class HannPitchShifter {
  private context: AudioContext;
  public input: GainNode;
  public output: GainNode;

  private delays: DelayNode[] = [];
  private tapGains: GainNode[] = [];
  private depthGains: GainNode[] = [];
  private dirGainsUp: GainNode[] = [];
  private dirGainsDown: GainNode[] = [];

  constructor(context: AudioContext) {
    this.context = context;
    this.input = context.createGain();
    this.output = context.createGain();
    // Sum of 4 Hann windows staggered by T/4 is identically 2.0 at all times.
    // Multiplying by 0.5 yields exact unity gain (1.0).
    this.output.gain.value = 0.5;

    const hannBuffer = createHannBuffer(context, GRAIN_PERIOD);
    const rampDownBuffer = createRampBuffer(context, GRAIN_PERIOD, true); // Pitch up (delay shrinks)
    const rampUpBuffer = createRampBuffer(context, GRAIN_PERIOD, false); // Pitch down (delay grows)

    const t0 = context.currentTime + 0.04;

    for (let k = 0; k < NUM_TAPS; k++) {
      const delay = context.createDelay(1.0);
      delay.delayTime.value = 0.0;
      this.delays.push(delay);

      const tapGain = context.createGain();
      tapGain.gain.value = 0.0;
      this.tapGains.push(tapGain);

      this.input.connect(delay);
      delay.connect(tapGain);
      tapGain.connect(this.output);

      // Hann window buffer source
      const hannSource = context.createBufferSource();
      hannSource.buffer = hannBuffer;
      hannSource.loop = true;
      hannSource.connect(tapGain.gain);

      // Delay modulation sources
      const upSource = context.createBufferSource();
      upSource.buffer = rampDownBuffer;
      upSource.loop = true;

      const downSource = context.createBufferSource();
      downSource.buffer = rampUpBuffer;
      downSource.loop = true;

      const upGain = context.createGain();
      upGain.gain.value = 0.0;
      this.dirGainsUp.push(upGain);

      const downGain = context.createGain();
      downGain.gain.value = 0.0;
      this.dirGainsDown.push(downGain);

      const depthGain = context.createGain();
      depthGain.gain.value = 0.0;
      this.depthGains.push(depthGain);

      upSource.connect(upGain);
      downSource.connect(downGain);
      upGain.connect(depthGain);
      downGain.connect(depthGain);
      depthGain.connect(delay.delayTime);

      const phaseOffset = (k * GRAIN_PERIOD) / NUM_TAPS;
      const startTime = t0 + phaseOffset;
      hannSource.start(startTime);
      upSource.start(startTime);
      downSource.start(startTime);
    }
  }

  public setPitchOffset(semitones: number): void {
    const now = this.context.currentTime;
    if (Math.abs(semitones) < 0.02) {
      for (let k = 0; k < NUM_TAPS; k++) {
        this.depthGains[k].gain.setTargetAtTime(0, now, 0.012);
      }
      return;
    }

    const mult = Math.pow(2, semitones / 12);
    const shiftUp = semitones > 0;
    const slope = Math.abs(1 - mult);
    // Doppler equation: delay modulation depth = slope * grain period
    const delayDepth = Math.min(0.035, slope * GRAIN_PERIOD);

    for (let k = 0; k < NUM_TAPS; k++) {
      if (shiftUp) {
        this.dirGainsUp[k].gain.setValueAtTime(1, now);
        this.dirGainsDown[k].gain.setValueAtTime(0, now);
      } else {
        this.dirGainsUp[k].gain.setValueAtTime(0, now);
        this.dirGainsDown[k].gain.setValueAtTime(1, now);
      }
      this.depthGains[k].gain.setTargetAtTime(delayDepth, now, 0.012);
    }
  }
}

function createReverbImpulseResponse(context: AudioContext): AudioBuffer {
  const duration = 2.8; // 2.8s lush reverb tail
  const decay = 2.4;
  const sampleRate = context.sampleRate;
  const length = Math.floor(sampleRate * duration);

  const buffer = context.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    // 15ms smooth attack prevents clicks, followed by exponential decay
    const attack = Math.min(1.0, t / 0.015);
    const env = attack * Math.exp((-2.5 * t) / decay);

    // Warm high-frequency damping over the course of the tail
    const damping = Math.max(0.15, 0.75 - 0.45 * (t / duration));

    const nL = Math.random() * 2 - 1;
    const nR = Math.random() * 2 - 1;

    lpL += damping * (nL - lpL);
    lpR += damping * (nR - lpR);

    // Stereo decorrelation for a wide, enveloping soundstage
    left[i] = lpL * env;
    right[i] = lpR * env;
  }

  // Normalize peak to 0.95
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const aL = Math.abs(left[i]);
    const aR = Math.abs(right[i]);
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
  }
  if (peak > 0) {
    const norm = 0.95 / peak;
    for (let i = 0; i < length; i++) {
      left[i] *= norm;
      right[i] *= norm;
    }
  }

  return buffer;
}

interface AudioEffectsGraph {
  ctx: AudioContext;
  sourceNode: MediaElementAudioSourceNode;
  pitchDryGain: GainNode;
  pitchWetGain: GainNode;
  pitchStageOutput: GainNode;
  shifter: HannPitchShifter;
  masterDryGain: GainNode;
  masterOutputGain: GainNode;
  reverbSendGain: GainNode;
  convolver: ConvolverNode;
  reverbHighpass: BiquadFilterNode;
  reverbWetGain: GainNode;
}

export interface AudioEffectsParams {
  pitchSemitones?: number;
  isPitchLinked?: boolean;
  isReverbEnabled?: boolean;
  reverbLevel?: number;
}

interface AttachedChain {
  graph: AudioEffectsGraph;
  destination: AudioNode;
}

export class PitchShifterController {
  private context: AudioContext | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private graph: AudioEffectsGraph | null = null;
  private isConnected = false;
  private chains = new WeakMap<MediaElementAudioSourceNode, AttachedChain>();

  /**
   * Insert the pitch/reverb graph into an existing source -> destination chain.
   * The caller owns the source (created by the equalizer), so we never create a
   * second MediaElementAudioSourceNode and never connect straight to the
   * speakers. The source is disconnected from its previous destination first so
   * the dry signal is not heard twice.
   */
  public attachToChain(
    context: AudioContext,
    sourceNode: MediaElementAudioSourceNode,
    destination: AudioNode,
  ): void {
    try {
      const existing = this.chains.get(sourceNode);
      if (
        existing &&
        existing.graph.ctx === context &&
        existing.destination === destination
      ) {
        this.context = context;
        this.sourceNode = sourceNode;
        this.graph = existing.graph;
        this.isConnected = true;
        return;
      }

      try {
        sourceNode.disconnect();
      } catch {
        // Already detached.
      }

      const graph = this.createGraph(context, sourceNode, destination);
      this.chains.set(sourceNode, { graph, destination });
      this.context = context;
      this.sourceNode = sourceNode;
      this.graph = graph;
      this.isConnected = true;
    } catch (err) {
      console.error("[AudioEffects] Failed to attach to audio chain:", err);
      this.isConnected = false;
    }
  }

  private createGraph(
    context: AudioContext,
    sourceNode: MediaElementAudioSourceNode,
    destination: AudioNode,
  ): AudioEffectsGraph {
    const pitchDryGain = context.createGain();
    const pitchWetGain = context.createGain();
    const pitchStageOutput = context.createGain();
    const masterDryGain = context.createGain();
    const masterOutputGain = context.createGain();

    // 100% dry bypass by default.
    pitchDryGain.gain.value = 1.0;
    pitchWetGain.gain.value = 0.0;
    masterDryGain.gain.value = 1.0;
    masterOutputGain.gain.value = 1.0;

    const shifter = new HannPitchShifter(context);

    // Pitch stage routing.
    sourceNode.connect(pitchDryGain);
    sourceNode.connect(pitchWetGain);

    pitchDryGain.connect(pitchStageOutput);
    pitchWetGain.connect(shifter.input);
    shifter.output.connect(pitchStageOutput);

    // Direct path from pitch stage to master.
    pitchStageOutput.connect(masterDryGain);
    masterDryGain.connect(masterOutputGain);

    // Reverb stage routing.
    const reverbSendGain = context.createGain();
    reverbSendGain.gain.value = 1.0;

    const convolver = context.createConvolver();
    convolver.normalize = true;
    convolver.buffer = createReverbImpulseResponse(context);

    // Filter out sub-bass mud from reverb (keeps kick/808 tight).
    const reverbHighpass = context.createBiquadFilter();
    reverbHighpass.type = "highpass";
    reverbHighpass.frequency.value = 120;
    reverbHighpass.Q.value = 0.7;

    const reverbWetGain = context.createGain();
    reverbWetGain.gain.value = 0.0;

    pitchStageOutput.connect(reverbSendGain);
    reverbSendGain.connect(convolver);
    convolver.connect(reverbHighpass);
    reverbHighpass.connect(reverbWetGain);
    reverbWetGain.connect(masterOutputGain);

    // Feed back into the equalizer input, not the raw AudioContext destination.
    masterOutputGain.connect(destination);

    return {
      ctx: context,
      sourceNode,
      pitchDryGain,
      pitchWetGain,
      pitchStageOutput,
      shifter,
      masterDryGain,
      masterOutputGain,
      reverbSendGain,
      convolver,
      reverbHighpass,
      reverbWetGain,
    };
  }

  public isAttached(): boolean {
    return this.isConnected;
  }

  public resumeContext(): void {
    if (this.context && this.context.state === "suspended") {
      void this.context.resume().catch(() => {});
    }
  }

  public update(
    arg1: number | AudioEffectsParams,
    arg2?: boolean,
    arg3?: boolean,
    arg4?: number,
  ): void {
    if (!this.isConnected || !this.context || !this.graph) return;

    this.resumeContext();

    let semitones = 0;
    let isPitchLinked = true;
    let isReverbEnabled = false;
    let reverbLevel = 0.35;

    if (typeof arg1 === "object" && arg1 !== null) {
      semitones = arg1.pitchSemitones ?? 0;
      isPitchLinked = arg1.isPitchLinked ?? true;
      isReverbEnabled = arg1.isReverbEnabled ?? false;
      reverbLevel = arg1.reverbLevel ?? 0.35;
    } else {
      semitones = typeof arg1 === "number" ? arg1 : 0;
      isPitchLinked = arg2 ?? true;
      isReverbEnabled = arg3 ?? false;
      reverbLevel = arg4 ?? 0.35;
    }

    const isPitchActive = !isPitchLinked && Math.abs(semitones) >= 0.05;
    const now = this.context.currentTime;

    // Pitch shift routing.
    if (isPitchActive) {
      this.graph.shifter.setPitchOffset(semitones);
      this.graph.pitchDryGain.gain.setTargetAtTime(0, now, 0.015);
      this.graph.pitchWetGain.gain.setTargetAtTime(1.0, now, 0.015);
    } else {
      this.graph.pitchDryGain.gain.setTargetAtTime(1.0, now, 0.015);
      this.graph.pitchWetGain.gain.setTargetAtTime(0, now, 0.015);
      this.graph.shifter.setPitchOffset(0);
    }

    // Reverb routing.
    if (isReverbEnabled && reverbLevel > 0.01) {
      const targetWet = Math.min(1.2, Math.max(0, reverbLevel));
      this.graph.reverbWetGain.gain.setTargetAtTime(targetWet, now, 0.020);
    } else {
      this.graph.reverbWetGain.gain.setTargetAtTime(0, now, 0.020);
    }
  }
}

export const pitchShifter = new PitchShifterController();
