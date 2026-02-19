/**
 * Piano inharmonicity model.
 *
 * The frequency of the nth partial of a piano string is:
 *   f_n = n * f0 * sqrt(1 + B * n^2)
 *
 * where B is the inharmonicity coefficient that depends on string
 * stiffness, length, diameter, and tension.
 *
 * B values follow a characteristic V-shaped curve across the keyboard:
 * - Decreasing through the wound bass strings (A0 ~ E3)
 * - Minimum near the bass-treble break (~E3/F3)
 * - Increasing through the plain steel treble strings (F3 ~ C8)
 *
 * Data sources:
 * - Steinway B grand: A0=0.000312, A3=0.000214, A4=0.000751
 * - Anderson & Strong (2005) Yamaha P22 upright
 * - UBC study (2021) Kimball & Yamaha uprights
 * - Fletcher (1964) Hamilton upright
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
 * Generic inharmonicity coefficient B for a given piano key (1-88).
 *
 * This uses a piecewise exponential model fitted to published measurements.
 * The bass-treble break is around key 28-32 (E3-G#3) depending on piano type.
 *
 * For grand pianos, the curve is lower overall due to longer strings.
 * For spinets, higher overall due to shorter strings.
 */
export function getInharmonicityB(key: number, pianoType: PianoType = 'grand'): number {
  // Scale factor relative to grand piano
  const typeScale: Record<PianoType, number> = {
    grand: 1.0,
    upright: 1.8,
    spinet: 3.0,
  };

  const scale = typeScale[pianoType];

  // Bass-treble break point (key number where wound strings end)
  const breakKey: Record<PianoType, number> = {
    grand: 30,   // ~F#3
    upright: 28,  // ~E3
    spinet: 28,
  };

  const bk = breakKey[pianoType];

  let B: number;

  if (key <= bk) {
    // Wound bass strings: B decreases from bass toward the break
    // Based on Steinway B data: A0 (key 1) ~ 0.000312, break ~ 0.00015
    // Exponential decay from bass to break
    const bassHigh = 0.00035 * scale;  // B at key 1 (A0)
    const bassLow = 0.00012 * scale;   // B at break point
    const t = (key - 1) / (bk - 1);
    B = bassHigh * Math.pow(bassLow / bassHigh, t);
  } else {
    // Plain steel treble strings: B increases from break toward top
    // Based on data: break ~ 0.00015, A4 (key 49) ~ 0.00075
    // Extrapolating: C8 (key 88) ~ 0.1-0.4
    const trebleLow = 0.00015 * scale;   // B at break point
    const trebleHigh = 0.15 * scale;     // B at key 88 (C8)
    const t = (key - bk) / (88 - bk);
    B = trebleLow * Math.pow(trebleHigh / trebleLow, t);
  }

  return B;
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
