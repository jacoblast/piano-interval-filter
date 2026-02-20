/**
 * Piano inharmonicity model.
 *
 * The frequency of the nth partial of a piano string is:
 *   f_n = n * f0 * sqrt(1 + B * n^2)
 *
 * where B is the inharmonicity coefficient that depends on string
 * stiffness, length, diameter, and tension.
 *
 * B is modelled as a two-term exponential in MIDI note number m:
 *   B(m) = exp(sB*m + yB) + exp(sT*m + yT)
 *
 * The bass term (sB < 0) decays with rising pitch; the treble term
 * (sT > 0) grows. Their sum produces the characteristic V-shaped
 * curve with a smooth crossover near the bass-treble break.
 *
 * Coefficients fitted from measurements on:
 * - Steinway B grand piano
 * - Upright piano
 * - Spinet piano
 */

export type PianoType = 'grand' | 'upright' | 'spinet';

// MIDI note numbers: A0=21, C4=60, C8=108
// Piano key numbers: A0=1, C8=88

/** Convert piano key number (1-88) to MIDI note number */
export function keyToMidi(key: number): number {
  return key + 20; // key 1 = A0 = MIDI 21
}

/** Convert MIDI note number to piano key number (1-88) */
export function midiToKey(midi: number): number {
  return midi - 20;
}

/** Concert pitch frequency for a MIDI note in 12-TET */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note number from frequency (fractional) */
export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/**
 * Measured inharmonicity coefficients per piano type.
 *
 * B(m) = exp(sB*m + yB) + exp(sT*m + yT)
 *
 * where m is the MIDI note number. The first term (bass) decays with
 * increasing pitch; the second term (treble) grows. Their sum produces
 * the characteristic V-shaped curve with a smooth crossover near the
 * bass-treble break.
 *
 * Fitted from measured data on real instruments.
 */
const INHARMONICITY_COEFFS: Record<PianoType, { sB: number; yB: number; sT: number; yT: number }> = {
  grand:   { sT:  0.09734982433, sB: -0.05083193872, yT: -14.02605102, yB: -7.676408327 },
  upright: { sT:  0.1151438886,  sB: -0.04752372189, yT: -15.51272618, yB: -7.178504653 },
  spinet:  { sT:  0.0958,        sB: -0.0528,        yT: -14.0,        yB: -5.88         },
};

/**
 * Inharmonicity coefficient B for a given piano key (1-88).
 *
 * Uses a two-term exponential model fitted to measured data:
 *   B(m) = exp(sB*m + yB) + exp(sT*m + yT)
 * where m is the MIDI note number.
 */
export function getInharmonicityB(key: number, pianoType: PianoType = 'grand'): number {
  const m = key + 20; // convert piano key (1-88) to MIDI note (21-108)
  const c = INHARMONICITY_COEFFS[pianoType];
  return Math.exp(c.sB * m + c.yB) + Math.exp(c.sT * m + c.yT);
}

/**
 * Compute the frequency of the nth partial of a piano string,
 * accounting for inharmonicity.
 *
 * @param f0 - fundamental frequency (Hz)
 * @param n - partial number (1 = fundamental, 2 = 2nd partial, etc.)
 * @param B - inharmonicity coefficient
 */
export function partialFrequency(f0: number, n: number, B: number): number {
  return n * f0 * Math.sqrt(1 + B * n * n);
}

/**
 * Find coincident (or near-coincident) partials between two notes.
 *
 * Returns pairs (m, n) where the mth partial of note1 is close to
 * the nth partial of note2, along with the actual frequencies and
 * the frequency difference (beat rate).
 */
export interface CoincidentPartial {
  m: number;           // partial number of note 1
  n: number;           // partial number of note 2
  freq1: number;       // actual frequency of partial m of note 1
  freq2: number;       // actual frequency of partial n of note 2
  centerFreq: number;  // average of freq1 and freq2
  beatRate: number;    // |freq1 - freq2| in Hz
}

export function findCoincidentPartials(
  f1: number,
  f2: number,
  B1: number,
  B2: number,
  maxPartial: number = 16,
  toleranceCents: number = 100,
): CoincidentPartial[] {
  const results: CoincidentPartial[] = [];

  for (let m = 1; m <= maxPartial; m++) {
    const fm = partialFrequency(f1, m, B1);
    for (let n = 1; n <= maxPartial; n++) {
      const fn = partialFrequency(f2, n, B2);
      // Check if they're within tolerance
      const centsDiff = Math.abs(1200 * Math.log2(fm / fn));
      if (centsDiff < toleranceCents) {
        results.push({
          m,
          n,
          freq1: fm,
          freq2: fn,
          centerFreq: (fm + fn) / 2,
          beatRate: Math.abs(fm - fn),
        });
      }
    }
  }

  // Sort by center frequency (lowest coincident partial first)
  results.sort((a, b) => a.centerFreq - b.centerFreq);
  return results;
}

/**
 * Standard interval names and their semitone distances.
 */
export const INTERVALS: Record<string, number> = {
  'Unison': 0,
  'Minor 2nd': 1,
  'Major 2nd': 2,
  'Minor 3rd': 3,
  'Major 3rd': 4,
  'Perfect 4th': 5,
  'Tritone': 6,
  'Perfect 5th': 7,
  'Minor 6th': 8,
  'Major 6th': 9,
  'Minor 7th': 10,
  'Major 7th': 11,
  'Octave': 12,
};

/** Note names */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToNoteName(midi: number): string {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function intervalName(semitones: number): string {
  const s = ((semitones % 12) + 12) % 12;
  for (const [name, st] of Object.entries(INTERVALS)) {
    if (st === s) return name;
  }
  return `${s} semitones`;
}
