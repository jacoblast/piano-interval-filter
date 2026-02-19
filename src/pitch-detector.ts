/**
 * Polyphonic pitch detection for two-note piano intervals.
 *
 * Strategy: Harmonic Product Spectrum (HPS) variant with iterative
 * subtraction for polyphonic detection.
 *
 * 1. Compute FFT magnitude spectrum
 * 2. Apply Harmonic Product Spectrum to find the strongest pitch
 * 3. Remove that pitch's harmonics from the spectrum (spectral subtraction)
 * 4. Apply HPS again to find the second pitch
 *
 * HPS is robust to missing fundamentals because it multiplies
 * downsampled copies of the spectrum — even if the fundamental is weak,
 * the upper harmonics will reinforce the correct f0.
 *
 * For piano-specific improvements:
 * - Use inharmonicity-aware harmonic templates for subtraction
 * - Weight the spectrum to de-emphasize noise floor
 * - Apply onset detection to trigger analysis only on note attacks
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
   * @param magnitudes - Float32Array of FFT magnitude values (linear, not dB)
   * @returns Array of 0-2 detected notes, sorted low to high
   */
  detect(magnitudes: Float32Array): DetectedNote[] {
    const spectrum = new Float32Array(magnitudes);
    const results: DetectedNote[] = [];

    // Apply A-weighting-like curve to reduce low-frequency noise sensitivity
    this.applyWeighting(spectrum);

    // First note: HPS on full spectrum
    const note1 = this.hpsDetect(spectrum);
    if (!note1) return results;
    results.push(note1);

    // Subtract first note's harmonics
    this.subtractHarmonics(spectrum, note1.frequency);

    // Second note: HPS on residual spectrum
    const note2 = this.hpsDetect(spectrum);
    if (note2 && Math.abs(note2.midi - note1.midi) >= 1) {
      results.push(note2);
    }

    // Sort low to high
    results.sort((a, b) => a.frequency - b.frequency);
    return results;
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
   */
  private subtractHarmonics(spectrum: Float32Array, f0: number): void {
    const midi = Math.round(freqToMidi(f0));
    const key = midiToKey(midi);
    const B = getInharmonicityB(Math.max(1, Math.min(88, key)), this.config.pianoType);

    const maxPartials = 20;
    for (let n = 1; n <= maxPartials; n++) {
      const partialFreq = partialFrequency(f0, n, B);
      const centerBin = Math.round(this.freqToBin(partialFreq));

      // Subtract a window around each partial
      const width = Math.max(3, Math.round(partialFreq * 0.02 / this.binResolution));
      for (let bin = centerBin - width; bin <= centerBin + width; bin++) {
        if (bin >= 0 && bin < spectrum.length) {
          // Gaussian-shaped subtraction
          const dist = (bin - centerBin) / (width / 2);
          const factor = Math.exp(-0.5 * dist * dist);
          spectrum[bin] *= (1 - factor * 0.9);
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
