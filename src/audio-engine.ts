/**
 * Audio engine: manages mic input, FFT analysis, and bandpass filter output.
 *
 * Signal chain:
 *   Mic -> AnalyserNode (for FFT)
 *       \-> BiquadFilter (bandpass) -> wetGain -> destination
 *
 * Detection state machine (sequential two-note workflow):
 *   idle → single → interval
 *
 *   idle:     nothing detected, waiting for first note
 *   single:   first note locked (detected in isolation), waiting for second
 *   interval: both notes locked, showing coincident partials
 *
 * Transitions:
 *   idle → single:     detectSingle finds a note above threshold
 *   single → interval: detectWithKnown finds a second note
 *   any → idle:        signal below threshold for holdFrames
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

type DetectionPhase = 'idle' | 'single' | 'interval';

export interface AudioEngineState {
  isRunning: boolean;
  phase: DetectionPhase;
  notes: DetectedNote[];
  coincidentPartials: CoincidentPartial[];
  activeFilterFreq: number | null;
  activeFilterQ: number;
  intervalLabel: string;
  peakDb: number;
  thresholdDb: number;
  gateOpen: boolean;
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
  private thresholdDb: number = -50;
  private holdFrames: number = 20;

  // Sequential detection state
  private phase: DetectionPhase = 'idle';
  private firstNote: DetectedNote | null = null;
  private secondNote: DetectedNote | null = null;
  private lockedPartials: CoincidentPartial[] = [];
  private lockedFilterFreq: number | null = null;
  private framesSinceDetection: number = Infinity;

  // Second-note confirmation: require consistent detection before locking
  private pendingSecondMidi: number = -1;
  private pendingSecondFrames: number = 0;
  private readonly requiredConfirmFrames: number = 5;

  // State
  private state: AudioEngineState = {
    isRunning: false,
    phase: 'idle',
    notes: [],
    coincidentPartials: [],
    activeFilterFreq: null,
    activeFilterQ: 30,
    intervalLabel: '',
    peakDb: -Infinity,
    thresholdDb: -50,
    gateOpen: false,
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

  setThreshold(db: number): void {
    this.thresholdDb = db;
    this.state.thresholdDb = db;
  }

  setHoldTime(frames: number): void {
    this.holdFrames = frames;
  }

  async start(): Promise<void> {
    if (this.ctx) return;

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

    this.source = this.ctx.createMediaStreamSource(stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.3;

    this.bandpass = this.ctx.createBiquadFilter();
    this.bandpass.type = 'bandpass';
    this.bandpass.frequency.value = 440;
    this.bandpass.Q.value = this.filterQ;

    this.wetGain = this.ctx.createGain();
    this.wetGain.gain.value = 0;

    this.source.connect(this.analyser);
    this.source.connect(this.bandpass);
    this.bandpass.connect(this.wetGain);
    this.wetGain.connect(this.ctx.destination);

    this.magnitudes = new Float32Array(this.analyser.frequencyBinCount);

    this.state.isRunning = true;
    this.emitState();
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
    this.resetDetection();
    this.state.isRunning = false;
    this.state.peakDb = -Infinity;
    this.state.gateOpen = false;
    this.emitState();
  }

  /** Reset detection state machine to idle */
  private resetDetection(): void {
    this.phase = 'idle';
    this.firstNote = null;
    this.secondNote = null;
    this.lockedPartials = [];
    this.lockedFilterFreq = null;
    this.framesSinceDetection = Infinity;
    this.pendingSecondMidi = -1;
    this.pendingSecondFrames = 0;
    this.state.phase = 'idle';
    this.state.notes = [];
    this.state.coincidentPartials = [];
    this.state.intervalLabel = '';
    this.clearFilter();
  }

  /**
   * Main analysis loop.
   *
   * State machine:
   *   idle:     run detectSingle → if found, lock as first note, go to 'single'
   *   single:   run detectWithKnown → if found, lock interval, go to 'interval'
   *             also re-confirm first note is still present via detectSingle
   *   interval: hold the result; re-confirm periodically
   *
   * Any state: if signal below threshold for holdFrames → reset to idle.
   */
  private analyze = (): void => {
    if (!this.analyser || !this.magnitudes || !this.ctx) return;

    const dBData = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(dBData);

    // Peak dB for metering/gating
    let peakDb = -Infinity;
    for (let i = 0; i < dBData.length; i++) {
      if (dBData[i] > peakDb) peakDb = dBData[i];
    }
    this.state.peakDb = peakDb;

    const gateOpen = peakDb >= this.thresholdDb;
    this.state.gateOpen = gateOpen;

    if (!gateOpen) {
      this.framesSinceDetection++;
      if (this.framesSinceDetection > this.holdFrames) {
        this.resetDetection();
      }
      // else: hold current state (keep showing whatever we had)
      this.emitState();
      this.animFrameId = requestAnimationFrame(this.analyze);
      return;
    }

    // Convert dB to linear magnitude
    for (let i = 0; i < dBData.length; i++) {
      this.magnitudes[i] = Math.pow(10, dBData[i] / 20);
    }

    if (this.phase === 'idle') {
      this.analyzeIdle();
    } else if (this.phase === 'single') {
      this.analyzeSingle();
    } else {
      this.analyzeInterval();
    }

    this.emitState();
    this.animFrameId = requestAnimationFrame(this.analyze);
  };

  /** idle: look for a single note */
  private analyzeIdle(): void {
    const note = this.detector.detectSingle(this.magnitudes!);
    if (note) {
      this.firstNote = note;
      this.phase = 'single';
      this.framesSinceDetection = 0;
      this.state.phase = 'single';
      this.state.notes = [note];
      this.state.intervalLabel = midiToNoteName(note.midi);
    }
  }

  /** single: first note locked, look for second */
  private analyzeSingle(): void {
    const mags = this.magnitudes!;

    // Try to find a second note by subtracting the known first
    const second = this.detector.detectWithKnown(mags, this.firstNote!.frequency);

    if (second) {
      // Require consistent detection across multiple frames to avoid
      // locking on spectral artifacts from imperfect subtraction
      if (second.midi === this.pendingSecondMidi) {
        this.pendingSecondFrames++;
      } else {
        this.pendingSecondMidi = second.midi;
        this.pendingSecondFrames = 1;
      }

      if (this.pendingSecondFrames >= this.requiredConfirmFrames) {
        // Confirmed — lock the interval
        this.secondNote = second;
        this.phase = 'interval';
        this.framesSinceDetection = 0;
        this.pendingSecondMidi = -1;
        this.pendingSecondFrames = 0;
        this.lockInterval();
        return;
      }

      // Still confirming — keep showing first note
      this.framesSinceDetection = 0;
      this.state.notes = [this.firstNote!];
      this.state.intervalLabel = midiToNoteName(this.firstNote!.midi);
      return;
    }

    // No second note detected — reset confirmation counter
    this.pendingSecondMidi = -1;
    this.pendingSecondFrames = 0;

    // Re-confirm first note is still there
    const recheck = this.detector.detectSingle(mags);
    if (recheck && Math.abs(recheck.midi - this.firstNote!.midi) <= 1) {
      // Same note still present
      this.firstNote = recheck;
      this.framesSinceDetection = 0;
      this.state.notes = [this.firstNote];
      this.state.intervalLabel = midiToNoteName(this.firstNote.midi);
    } else if (recheck) {
      // Different note — switch to it
      this.firstNote = recheck;
      this.framesSinceDetection = 0;
      this.pendingSecondMidi = -1;
      this.pendingSecondFrames = 0;
      this.state.notes = [this.firstNote];
      this.state.intervalLabel = midiToNoteName(this.firstNote.midi);
    } else {
      // Lost the note
      this.framesSinceDetection++;
      if (this.framesSinceDetection > this.holdFrames) {
        this.resetDetection();
      }
    }
  }

  /** interval: both notes locked, hold and display */
  private analyzeInterval(): void {
    // The interval is locked — just hold it.
    // The threshold gate + hold timer handles cleanup.
    this.framesSinceDetection = 0;

    // Optionally: re-confirm the interval is still present.
    // For now, we trust the lock and let the gate clear it when notes decay.
  }

  /** Compute and store coincident partials for the locked note pair */
  private lockInterval(): void {
    const notes = [this.firstNote!, this.secondNote!].sort((a, b) => a.frequency - b.frequency);
    const [low, high] = notes;
    const semitones = Math.round(high.midi - low.midi);

    const key1 = midiToKey(low.midi);
    const key2 = midiToKey(high.midi);
    const B1 = getInharmonicityB(Math.max(1, Math.min(88, key1)), this.pianoType);
    const B2 = getInharmonicityB(Math.max(1, Math.min(88, key2)), this.pianoType);

    this.lockedPartials = findCoincidentPartials(
      midiToFreq(low.midi), midiToFreq(high.midi),
      B1, B2, 8, 80
    );
    this.lockedFilterFreq = this.lockedPartials.length > 0
      ? this.lockedPartials[0].centerFreq
      : null;

    this.state.phase = 'interval';
    this.state.notes = notes;
    this.state.coincidentPartials = this.lockedPartials;
    this.state.intervalLabel =
      `${midiToNoteName(low.midi)} - ${midiToNoteName(high.midi)} (${intervalName(semitones)})`;

    if (this.lockedFilterFreq !== null) {
      this.setFilter(this.lockedFilterFreq);
    }
  }

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
      this.lockedFilterFreq = target.centerFreq;
    }
  }

  private emitState(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }
}
