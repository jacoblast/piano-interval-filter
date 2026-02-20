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

## YIN Pitch Detection Strategy

Replace HPS with YIN as the primary pitch estimator. HPS struggles with octave errors, especially above G4 where inharmonicity shifts partials away from integer multiples. YIN (autocorrelation-based, time-domain) is more robust thanks to its cumulative mean normalized difference (CMND).

### Core algorithm (new code in `pitch-detector.ts`)

1. **Difference function**: `d(τ) = Σ(x[j] - x[j+τ])²` for lags τ from 1 to W (W = fftSize/2).
2. **CMND normalization**: `d'(τ) = d(τ) / ((1/τ) Σ d(j))` for j=1..τ. Suppresses spurious subharmonic dips.
3. **Dip search**: Find all CMND dips below threshold (0.10–0.15). Shortest-lag dip = highest pitch.
4. **Parabolic interpolation**: Sub-sample accuracy on CMND dips (critical for high notes where period < 15 samples).
5. **Confidence**: Map CMND dip value to existing confidence field: `confidence = 1 - cmndDip`.

### Data flow change in `audio-engine.ts`

Add `getFloatTimeDomainData()` call alongside existing `getFloatFrequencyData()` on the same AnalyserNode. Pass time-domain buffer to YIN methods. FFT data still used for spectral flux onset detection and as fallback input for HPS.

### Detection phases

**Phase 1 — Single note (`detectSingle`):**
- Run YIN on time-domain buffer. First reliable CMND dip = detected pitch.
- If YIN finds no dip below threshold, fall back to HPS on FFT magnitudes.
- Either note may be played first — no ordering constraint.

**Phase 2 — Second note (`detectWithKnown`):**
- Layered approach:
  1. Run YIN on the raw mixed signal. Collect all reliable CMND dips.
  2. Reject dips matching the known note's period or its integer multiples (inharmonicity-aware: check against `partialFrequency(f_known, n, B)` positions).
  3. If a non-matching dip remains → second note candidate.
  4. If all dips match the known note (common for octaves, 12ths, double octaves where the lower note's fundamental IS a subharmonic of the upper note), fall back to spectral subtraction + HPS on residual (the existing approach — it works for these cases).
- The state machine, onset gating, debounce, and confirmation logic remain unchanged.

### What stays the same

- `inharmonicity.ts` — untouched (pure math, no audio dependencies).
- State machine in `audio-engine.ts` (idle → single → interval).
- Spectral flux onset detection (FFT-based, gates second-note search window).
- Signal chain: Mic → AnalyserNode + BiquadFilter → GainNode → speakers.
- `ui.ts` — state callback interface unchanged.
- Hold/debounce/confirmation logic.

### Performance notes

- Naive difference function: O(W × τ_max) ≈ 7M ops/frame (W=4096, τ_max for A0 ≈ 1745 at 48kHz). Fine at 60fps.
- If performance is tight, optimize via FFT-based autocorrelation: `d(τ) = r(0) + r_shifted(0) - 2r(τ)`, reducing to O(N log N).
- Can narrow τ_max search range when the detection phase constrains expected frequencies.

### Buffer requirements

- `fftSize=8192` at 48kHz → 8192 time-domain samples → ~170ms → ~4.7 periods of A0 (27.5 Hz). Sufficient.
- `getFloatTimeDomainData()` returns raw samples (no smoothing applied, unlike frequency data which has `smoothingTimeConstant=0.3`). This is correct for YIN.
