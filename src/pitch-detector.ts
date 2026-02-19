/**
 * Pitch detection for sequential two-note piano intervals.
 *
 * Designed for the workflow: play note 1 alone, then add note 2.
 *
 * - detectSingle(): HPS on the full spectrum — reliable when one note is playing
 * - detectWithKnown(): subtract a known note's harmonics, then HPS the residual
 *
 * The audio engine manages the state machine (idle → single → interval).
 * This keeps the detector stateless and easy to reason about.
 */

import { partialFrequency, getInharmonicityB, midiToKey, freqToMidi, type PianoType } from './inharmonicity.js';

export interface DetectedNote {
  midi: number;       // nearest MIDI note number
  frequency: number;  // detected frequency in Hz
  confidence: number; // 0-1 detection confidence
}

export interface PitchDetectorConfig {
  sampleRate: number;
  fftSize: number;
  pianoType: PianoType;
  minMidi: number;  // lowest note to detect (default: 21 = A0)
  maxMidi: number;  // highest note to detect (default: 108 = C8)
  hpsOrder: number; // number of HPS downsampling stages (default: 5)
  secondNoteMinConfidence: number; // min confidence for detectWithKnown (default: 0.15)
  subtractionStrength: number;     // harmonic subtraction factor 0-1 (default: 0.92)
  harmonicRejectCents: number;     // reject 2nd note within N cents of any partial (default: 40)
}

const DEFAULT_CONFIG: PitchDetectorConfig = {
  sampleRate: 48000,
  fftSize: 8192,
  pianoType: 'grand',
  minMidi: 21,
  maxMidi: 108,
  hpsOrder: 5,
  secondNoteMinConfidence: 0.15,
  subtractionStrength: 0.92,
  harmonicRejectCents: 40,
};

export class PitchDetector {
  private config: PitchDetectorConfig;
  private binResolution: number; // Hz per FFT bin

  constructor(config: Partial<PitchDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.binResolution = this.config.sampleRate / this.config.fftSize;
  }

  updateConfig(config: Partial<PitchDetectorConfig>): void {
    Object.assign(this.config, config);
    this.binResolution = this.config.sampleRate / this.config.fftSize;
  }

  /**
   * Detect the single strongest pitch in the spectrum.
   * Used when only one note is expected to be playing.
   */
  detectSingle(magnitudes: Float32Array): DetectedNote | null {
    const spectrum = new Float32Array(magnitudes);
    this.applyWeighting(spectrum);
    return this.hpsDetect(spectrum);
  }

  /**
   * Detect a second pitch by subtracting a known note's harmonics first.
   * The known note was detected earlier in isolation, so its frequency
   * is reliable. This avoids the hard problem of blind polyphonic separation.
   *
   * @param magnitudes - current FFT magnitude spectrum
   * @param knownFreq - frequency of the already-locked first note
   * @returns the second detected note, or null
   */
  detectWithKnown(magnitudes: Float32Array, knownFreq: number): DetectedNote | null {
    const spectrum = new Float32Array(magnitudes);
    this.applyWeighting(spectrum);
    this.subtractHarmonics(spectrum, knownFreq);
    const note = this.hpsDetect(spectrum);
    if (!note) return null;

    // Require higher confidence than general detection
    if (note.confidence < this.config.secondNoteMinConfidence) return null;

    // Reject if it's the same note as the known one
    const knownMidi = Math.round(freqToMidi(knownFreq));
    if (Math.abs(note.midi - knownMidi) < 1) return null;

    // Reject if the candidate is close to any partial of the known note.
    // A rising partial of note 1 should not be mistaken for a new note.
    if (this.isNearHarmonic(note.frequency, knownFreq)) return null;

    return note;
  }

  /**
   * Harmonic Product Spectrum pitch detection.
   *
   * Multiplies the spectrum with downsampled versions of itself.
   * The product peaks at the fundamental frequency even if the
   * fundamental partial is weak or missing.
   */
  private hpsDetect(spectrum: Float32Array): DetectedNote | null {
    const { hpsOrder, minMidi, maxMidi } = this.config;
    const minBin = Math.max(1, Math.floor(this.freqToBin(this.midiToFreq(minMidi))));
    const maxBin = Math.min(
      Math.floor(spectrum.length / hpsOrder),
      Math.ceil(this.freqToBin(this.midiToFreq(maxMidi)))
    );

    if (minBin >= maxBin) return null;

    // Compute HPS
    const hps = new Float32Array(maxBin);
    for (let bin = minBin; bin < maxBin; bin++) {
      let product = spectrum[bin];
      for (let h = 2; h <= hpsOrder; h++) {
        const hBin = bin * h;
        if (hBin < spectrum.length) {
          product *= spectrum[hBin];
        } else {
          product = 0;
          break;
        }
      }
      hps[bin] = product;
    }

    // Find peak in HPS
    let peakBin = minBin;
    let peakVal = 0;
    for (let bin = minBin; bin < maxBin; bin++) {
      if (hps[bin] > peakVal) {
        peakVal = hps[bin];
        peakBin = bin;
      }
    }

    if (peakVal === 0) return null;

    // Parabolic interpolation for sub-bin accuracy
    const freq = this.parabolicInterp(hps, peakBin);
    const midi = freqToMidi(freq);

    // Confidence: ratio of peak to median
    const sorted = Array.from(hps.slice(minBin, maxBin)).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const confidence = median > 0 ? Math.min(1, peakVal / (median * 100)) : 0;

    if (confidence < 0.05) return null;

    return {
      midi: Math.round(midi),
      frequency: freq,
      confidence,
    };
  }

  /**
   * Check if a frequency is within harmonicRejectCents of any partial
   * of a known fundamental. Used to reject false second-note detections
   * caused by fluctuating partials of the first note.
   */
  private isNearHarmonic(candidateFreq: number, knownFreq: number): boolean {
    const { harmonicRejectCents, pianoType } = this.config;
    if (harmonicRejectCents <= 0) return false;

    const midi = Math.round(freqToMidi(knownFreq));
    const key = midiToKey(midi);
    const B = getInharmonicityB(Math.max(1, Math.min(88, key)), pianoType);

    const maxPartials = 16;
    for (let n = 2; n <= maxPartials; n++) { // start at 2; partial 1 = fundamental already rejected
      const partialFreq = partialFrequency(knownFreq, n, B);
      const cents = Math.abs(1200 * Math.log2(candidateFreq / partialFreq));
      if (cents < harmonicRejectCents) return true;
    }
    return false;
  }

  /**
   * Subtract harmonics of a known pitch from the spectrum.
   * Uses inharmonicity-aware partial frequencies.
   */
  private subtractHarmonics(spectrum: Float32Array, f0: number): void {
    const midi = Math.round(freqToMidi(f0));
    const key = midiToKey(midi);
    const B = getInharmonicityB(Math.max(1, Math.min(88, key)), this.config.pianoType);
    const strength = this.config.subtractionStrength;

    const maxPartials = 16;
    for (let n = 1; n <= maxPartials; n++) {
      const partialFreq = partialFrequency(f0, n, B);
      const centerBin = Math.round(this.freqToBin(partialFreq));

      const width = Math.max(3, Math.round(partialFreq * 0.02 / this.binResolution));
      for (let bin = centerBin - width; bin <= centerBin + width; bin++) {
        if (bin >= 0 && bin < spectrum.length) {
          const dist = (bin - centerBin) / (width / 2);
          const factor = Math.exp(-0.5 * dist * dist);
          spectrum[bin] *= (1 - factor * strength);
        }
      }
    }
  }

  /**
   * Apply perceptual weighting to reduce low-frequency noise.
   * Simplified A-weighting approximation.
   */
  private applyWeighting(spectrum: Float32Array): void {
    for (let bin = 0; bin < spectrum.length; bin++) {
      const freq = bin * this.binResolution;
      if (freq < 20) {
        spectrum[bin] = 0;
      } else if (freq < 100) {
        spectrum[bin] *= (freq - 20) / 80;
      }
    }
  }

  /** Convert frequency to FFT bin number (fractional) */
  private freqToBin(freq: number): number {
    return freq / this.binResolution;
  }

  /** Convert MIDI to frequency */
  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * Parabolic interpolation around a peak bin for sub-bin frequency accuracy.
   */
  private parabolicInterp(spectrum: Float32Array, peakBin: number): number {
    if (peakBin <= 0 || peakBin >= spectrum.length - 1) {
      return peakBin * this.binResolution;
    }

    const alpha = Math.log(spectrum[peakBin - 1] + 1e-10);
    const beta = Math.log(spectrum[peakBin] + 1e-10);
    const gamma = Math.log(spectrum[peakBin + 1] + 1e-10);

    const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
    const interpolatedBin = peakBin + p;

    return interpolatedBin * this.binResolution;
  }
}
