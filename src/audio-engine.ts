/**
 * Audio engine: manages mic input, FFT analysis, and bandpass filter output.
 *
 * Signal chain:
 *   Mic -> AnalyserNode (for FFT) -> gain (dry, muted by default)
 *                                 \-> BiquadFilter (bandpass) -> gain (wet) -> destination
 *
 * The analyser feeds FFT data to the pitch detector.
 * When coincident partials are found, the bandpass filter is set to
 * isolate them, and the wet gain fades in.
 */

import { PitchDetector, type DetectedNote } from './pitch-detector.js';
import {
  findCoincidentPartials,
  getInharmonicityB,
  midiToKey,
  midiToFreq,
  midiToNoteName,
  intervalName,
  type CoincidentPartial,
  type PianoType,
} from './inharmonicity.js';

export interface AudioEngineState {
  isRunning: boolean;
  notes: DetectedNote[];
  coincidentPartials: CoincidentPartial[];
  activeFilterFreq: number | null;
  activeFilterQ: number;
  intervalLabel: string;
}

export type StateCallback = (state: AudioEngineState) => void;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private bandpass: BiquadFilterNode | null = null;
  private wetGain: GainNode | null = null;
  private detector: PitchDetector;
  private magnitudes: Float32Array | null = null;
  private animFrameId: number = 0;
  private onStateChange: StateCallback | null = null;
  private pianoType: PianoType = 'grand';
  private filterQ: number = 30;

  // State
  private state: AudioEngineState = {
    isRunning: false,
    notes: [],
    coincidentPartials: [],
    activeFilterFreq: null,
    activeFilterQ: 30,
    intervalLabel: '',
  };

  constructor() {
    this.detector = new PitchDetector();
  }

  setStateCallback(cb: StateCallback): void {
    this.onStateChange = cb;
  }

  setPianoType(type: PianoType): void {
    this.pianoType = type;
    this.detector.updateConfig({ pianoType: type });
  }

  setFilterQ(q: number): void {
    this.filterQ = q;
    if (this.bandpass) {
      this.bandpass.Q.value = q;
    }
    this.state.activeFilterQ = q;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

    // Request microphone
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.ctx = new AudioContext();
    const sampleRate = this.ctx.sampleRate;

    this.detector.updateConfig({ sampleRate, fftSize: 8192 });

    // Source
    this.source = this.ctx.createMediaStreamSource(stream);

    // Analyser for FFT
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.3;

    // Bandpass filter
    this.bandpass = this.ctx.createBiquadFilter();
    this.bandpass.type = 'bandpass';
    this.bandpass.frequency.value = 440;
    this.bandpass.Q.value = this.filterQ;

    // Wet gain (starts silent, fades in when filter is set)
    this.wetGain = this.ctx.createGain();
    this.wetGain.gain.value = 0;

    // Connect: source -> analyser (no output to speakers — avoids feedback)
    // source -> bandpass -> wetGain -> destination (headphone output)
    this.source.connect(this.analyser);
    this.source.connect(this.bandpass);
    this.bandpass.connect(this.wetGain);
    this.wetGain.connect(this.ctx.destination);

    // Allocate magnitude buffer
    this.magnitudes = new Float32Array(this.analyser.frequencyBinCount);

    this.state.isRunning = true;
    this.emitState();

    // Start analysis loop
    this.analyze();
  }

  stop(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    if (this.source) {
      this.source.mediaStream.getTracks().forEach(t => t.stop());
      this.source.disconnect();
      this.source = null;
    }
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.state.isRunning = false;
    this.state.notes = [];
    this.state.coincidentPartials = [];
    this.state.activeFilterFreq = null;
    this.state.intervalLabel = '';
    this.emitState();
  }

  /**
   * Main analysis loop — runs on requestAnimationFrame (~60fps).
   * Pitch detection and filter updates happen here.
   */
  private analyze = (): void => {
    if (!this.analyser || !this.magnitudes || !this.ctx) return;

    // Get frequency data (linear magnitude, not dB)
    // getByteFrequencyData gives 0-255 log scale, which loses resolution.
    // Instead we use getFloatFrequencyData (dB) and convert to linear.
    const dBData = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(dBData);

    // Convert dB to linear magnitude
    for (let i = 0; i < dBData.length; i++) {
      this.magnitudes[i] = Math.pow(10, dBData[i] / 20);
    }

    // Detect pitches
    const notes = this.detector.detect(this.magnitudes);
    this.state.notes = notes;

    if (notes.length === 2) {
      const [low, high] = notes;
      const semitones = Math.round(high.midi - low.midi);

      // Get inharmonicity for both notes
      const key1 = midiToKey(low.midi);
      const key2 = midiToKey(high.midi);
      const B1 = getInharmonicityB(Math.max(1, Math.min(88, key1)), this.pianoType);
      const B2 = getInharmonicityB(Math.max(1, Math.min(88, key2)), this.pianoType);

      // Find coincident partials
      const coincident = findCoincidentPartials(
        midiToFreq(low.midi), midiToFreq(high.midi),
        B1, B2, 16, 80
      );

      this.state.coincidentPartials = coincident;
      this.state.intervalLabel =
        `${midiToNoteName(low.midi)} - ${midiToNoteName(high.midi)} (${intervalName(semitones)})`;

      // Set bandpass to the lowest coincident partial
      if (coincident.length > 0) {
        const target = coincident[0];
        this.setFilter(target.centerFreq);
      } else {
        this.clearFilter();
      }
    } else if (notes.length < 2) {
      this.state.coincidentPartials = [];
      this.state.intervalLabel = notes.length === 1
        ? midiToNoteName(notes[0].midi)
        : '';
      this.clearFilter();
    }

    this.emitState();
    this.animFrameId = requestAnimationFrame(this.analyze);
  };

  /** Set the bandpass filter to a specific frequency and fade in */
  private setFilter(freq: number): void {
    if (!this.bandpass || !this.wetGain || !this.ctx) return;

    this.bandpass.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.05);
    this.wetGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.1);
    this.state.activeFilterFreq = freq;
  }

  /** Fade out the filter */
  private clearFilter(): void {
    if (!this.wetGain || !this.ctx) return;
    this.wetGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.state.activeFilterFreq = null;
  }

  /** Select which coincident partial to filter */
  selectPartial(index: number): void {
    if (index >= 0 && index < this.state.coincidentPartials.length) {
      const target = this.state.coincidentPartials[index];
      this.setFilter(target.centerFreq);
    }
  }

  private emitState(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }
}
