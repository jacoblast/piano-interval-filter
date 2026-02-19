/**
 * Polyphonic pitch detection for two-note piano intervals.
 *
 * Strategy: Harmonic Product Spectrum (HPS) with bidirectional
 * subtraction for robust polyphonic detection.
 *
 * Forward pass:
 * 1. HPS on weighted spectrum → strongest pitch
 * 2. Subtract that pitch's harmonics (tapered strength)
 * 3. HPS on residual → second pitch
 *
 * Reverse pass (for wide intervals like 3:1, 5:1):
 * 1. Find dominant note, suppress only its fundamental
 * 2. HPS to find the other note
 * 3. Subtract that note's harmonics from original, re-detect first
 *
 * Picks whichever pass yields better combined confidence.
 * The reverse pass helps when a high partial of the lower note
 * coincides with the upper note's fundamental — forward subtraction
 * would destroy it, but reverse subtraction preserves it.
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
}

const DEFAULT_CONFIG: PitchDetectorConfig = {
  sampleRate: 48000,
  fftSize: 8192,
  pianoType: 'grand',
  minMidi: 21,
  maxMidi: 108,
  hpsOrder: 5,
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
   * Detect up to two pitches from an FFT magnitude spectrum.
   *
   * Uses bidirectional detection: tries subtracting note1 first, then
   * alternatively subtracting note2 first, and picks the pair with
   * better combined confidence. This helps with wide intervals (3:1, 5:1)
   * where a high partial of the lower note coincides with the upper
   * note's fundamental — subtracting the lower note first would destroy it.
   *
   * @param magnitudes - Float32Array of FFT magnitude values (linear, not dB)
   * @returns Array of 0-2 detected notes, sorted low to high
   */
  detect(magnitudes: Float32Array): DetectedNote[] {
    const weighted = new Float32Array(magnitudes);
    this.applyWeighting(weighted);

    // Forward pass: find strongest note, subtract, find second
    const fwd = this.detectPass(weighted);

    // If forward found 2 notes, try reverse pass for comparison
    if (fwd.length === 2) {
      const rev = this.detectPassReverse(weighted);
      if (rev.length === 2) {
        const fwdConf = fwd[0].confidence + fwd[1].confidence;
        const revConf = rev[0].confidence + rev[1].confidence;
        if (revConf > fwdConf) {
          return rev;
        }
      }
    }

    return fwd;
  }

  /**
   * Forward detection pass: find strongest note first, subtract, find second.
   */
  private detectPass(weighted: Float32Array): DetectedNote[] {
    const spectrum = new Float32Array(weighted);
    const results: DetectedNote[] = [];

    const note1 = this.hpsDetect(spectrum);
    if (!note1) return results;
    results.push(note1);

    this.subtractHarmonics(spectrum, note1.frequency);

    const note2 = this.hpsDetect(spectrum);
    if (note2 && Math.abs(note2.midi - note1.midi) >= 1) {
      results.push(note2);
    }

    results.sort((a, b) => a.frequency - b.frequency);
    return results;
  }

  /**
   * Reverse detection pass: find the second-strongest note by suppressing
   * a region around the dominant peak, then subtract the second note and
   * re-detect the first from the original spectrum.
   *
   * This catches wide intervals where forward subtraction destroys the
   * upper note's fundamental.
   */
  private detectPassReverse(weighted: Float32Array): DetectedNote[] {
    // Find dominant note
    const specA = new Float32Array(weighted);
    const dominant = this.hpsDetect(specA);
    if (!dominant) return [];

    // Suppress dominant fundamental region (not full harmonic subtraction)
    // to find a different note
    const specB = new Float32Array(weighted);
    this.suppressFundamental(specB, dominant.frequency);

    const other = this.hpsDetect(specB);
    if (!other || Math.abs(other.midi - dominant.midi) < 1) return [];

    // Now verify: subtract 'other' from original and re-detect dominant
    const specC = new Float32Array(weighted);
    this.subtractHarmonics(specC, other.frequency);
    const redetected = this.hpsDetect(specC);
    if (!redetected || Math.abs(redetected.midi - dominant.midi) > 1) return [];

    const results = [
      { ...redetected }, // use re-detected confidence (from cleaner spectrum)
      { ...other },
    ];
    results.sort((a, b) => a.frequency - b.frequency);
    return results;
  }

  /**
   * Suppress only the fundamental region of a note (not its harmonics).
   * Used in reverse pass to find a different note without destroying
   * harmonic relationships.
   */
  private suppressFundamental(spectrum: Float32Array, f0: number): void {
    const centerBin = Math.round(this.freqToBin(f0));
    // Suppress a ±1 semitone region around the fundamental
    const width = Math.max(4, Math.round(f0 * 0.06 / this.binResolution));
    for (let bin = centerBin - width; bin <= centerBin + width; bin++) {
      if (bin >= 0 && bin < spectrum.length) {
        const dist = (bin - centerBin) / (width / 2);
        const factor = Math.exp(-0.5 * dist * dist);
        spectrum[bin] *= (1 - factor * 0.95);
      }
    }
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
   * Subtract harmonics of a detected pitch from the spectrum.
   * Uses inharmonicity-aware partial frequencies.
   *
   * Subtraction strength tapers for higher partials — this preserves
   * energy at frequencies where another note's fundamental might live
   * (critical for wide intervals like 3:1, 5:1).
   */
  private subtractHarmonics(spectrum: Float32Array, f0: number): void {
    const midi = Math.round(freqToMidi(f0));
    const key = midiToKey(midi);
    const B = getInharmonicityB(Math.max(1, Math.min(88, key)), this.config.pianoType);

    const maxPartials = 12;
    for (let n = 1; n <= maxPartials; n++) {
      const partialFreq = partialFrequency(f0, n, B);
      const centerBin = Math.round(this.freqToBin(partialFreq));

      // Taper: full subtraction for partials 1-3, declining after
      const strength = n <= 3 ? 0.9 : 0.9 * Math.max(0.15, 1 - (n - 3) * 0.1);

      // Subtract a window around each partial
      const width = Math.max(3, Math.round(partialFreq * 0.02 / this.binResolution));
      for (let bin = centerBin - width; bin <= centerBin + width; bin++) {
        if (bin >= 0 && bin < spectrum.length) {
          // Gaussian-shaped subtraction
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
        // Ramp up from 20-100 Hz
        spectrum[bin] *= (freq - 20) / 80;
      }
      // Above 100 Hz, keep as-is (piano range is 27.5 Hz - 4186 Hz)
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
