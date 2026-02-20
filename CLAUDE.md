# Piano Interval Filter

Real-time piano interval detection with coincident partial filtering for aural tuning training. A single-page web app that listens via microphone, detects two piano notes played sequentially, computes their coincident partials (accounting for inharmonicity), and applies a bandpass filter to isolate the beating partial.

## Build & Run

```bash
npm install        # install deps (vite + typescript only)
npm run dev        # dev server with HMR
npm run build      # typecheck (tsc) then production build to dist/
npm run preview    # serve the production build locally
```

No test framework is configured. Verify changes with `npx tsc --noEmit` (typecheck) and `npx vite build` (full build).

## Architecture

Single-page app: `index.html` (styles + layout) + 4 TypeScript modules in `src/`. No framework, no runtime dependencies. Vite bundles for production; deploys to GitHub Pages via `.github/workflows/deploy.yml`.

### Source files

- **`src/main.ts`** — Entry point. Calls `initUI()` on DOMContentLoaded.
- **`src/ui.ts`** — DOM bindings. Wires controls/sliders to `AudioEngine`, renders state updates (level meter, notes, partials table, filter status).
- **`src/audio-engine.ts`** — Core audio pipeline and detection state machine.
  - Signal chain: Mic → AnalyserNode (FFT) + BiquadFilter (bandpass) → GainNode → speakers
  - State machine: `idle` → `single` → `interval`. Sequential workflow: detect note 1 alone, then detect note 2 via harmonic subtraction.
  - Spectral flux onset detection gates the second-note search window.
  - On interval lock: computes coincident partials, activates bandpass on the lowest one.
- **`src/pitch-detector.ts`** — Stateless pitch detection.
  - `detectSingle()`: inharmonicity-aware HPS on full spectrum.
  - `detectWithKnown()`: subtract known note's harmonics, then HPS on residual.
  - Harmonic rejection prevents partials of note 1 from being mistaken for note 2.
- **`src/inharmonicity.ts`** — Piano physics model.
  - `B(m) = exp(sB*m + yB) + exp(sT*m + yT)` — two-term exponential fitted from real instrument measurements (grand/upright/spinet).
  - `partialFrequency(f0, n, B)` — inharmonic partial: `n * f0 * sqrt(1 + B*n^2)`
  - `findCoincidentPartials()` — brute-force search for near-coincident partial pairs between two notes.
  - Utility conversions: MIDI ↔ key ↔ freq ↔ note name, interval naming.

### Key types

- `PianoType`: `'grand' | 'upright' | 'spinet'`
- `DetectedNote`: `{ midi, frequency, confidence }`
- `CoincidentPartial`: `{ m, n, freq1, freq2, centerFreq, beatRate }`
- `AudioEngineState`: full snapshot emitted each frame to the UI callback

## Coding Conventions

- TypeScript strict mode (`noUnusedLocals`, `noUnusedParameters`).
- ES modules with `.js` extensions in imports (Vite resolves `.ts` at build time).
- No framework — direct DOM manipulation in `ui.ts`.
- All audio/DSP logic in `audio-engine.ts` and `pitch-detector.ts`; `inharmonicity.ts` is pure math with no Web Audio dependencies.
- Piano key numbers are 1-88 (A0=1, C8=88); MIDI note numbers are 21-108. Conversion: `midi = key + 20`.

## Current TODO

- **Implement YIN top-pitch-first strategy**: Replace or augment the current HPS-based pitch detection with YIN algorithm, using a top-pitch-first approach for better accuracy on piano signals (HPS struggles with octave errors and high inharmonicity in the upper register).
