/**
 * UI controller — binds DOM elements to AudioEngine state.
 */

import { AudioEngine, type AudioEngineState } from './audio-engine.js';
import type { PianoType } from './inharmonicity.js';

export function initUI(): void {
  const engine = new AudioEngine();

  // DOM elements
  const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
  const pianoSelect = document.getElementById('piano-type') as HTMLSelectElement;
  const filterQSlider = document.getElementById('filter-q') as HTMLInputElement;
  const filterQValue = document.getElementById('filter-q-value') as HTMLSpanElement;
  const thresholdSlider = document.getElementById('threshold') as HTMLInputElement;
  const thresholdValue = document.getElementById('threshold-value') as HTMLSpanElement;
  const holdTimeSlider = document.getElementById('hold-time') as HTMLInputElement;
  const holdTimeValue = document.getElementById('hold-time-value') as HTMLSpanElement;
  const levelBar = document.getElementById('level-bar') as HTMLElement;
  const levelDb = document.getElementById('level-db') as HTMLElement;
  const thresholdMarker = document.getElementById('threshold-marker') as HTMLElement;
  const notesDisplay = document.getElementById('notes-display') as HTMLElement;
  const intervalDisplay = document.getElementById('interval-display') as HTMLElement;
  const filterDisplay = document.getElementById('filter-display') as HTMLElement;
  const partialsTable = document.getElementById('partials-table') as HTMLElement;
  const statusIndicator = document.getElementById('status') as HTMLElement;

  // Wire up controls
  startBtn.addEventListener('click', async () => {
    try {
      await engine.start();
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusIndicator.textContent = 'Listening...';
      statusIndicator.className = 'status active';
    } catch (err) {
      statusIndicator.textContent = `Error: ${err}`;
      statusIndicator.className = 'status error';
    }
  });

  stopBtn.addEventListener('click', () => {
    engine.stop();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusIndicator.textContent = 'Stopped';
    statusIndicator.className = 'status';
  });

  pianoSelect.addEventListener('change', () => {
    engine.setPianoType(pianoSelect.value as PianoType);
  });

  filterQSlider.addEventListener('input', () => {
    const q = parseFloat(filterQSlider.value);
    engine.setFilterQ(q);
    filterQValue.textContent = q.toFixed(0);
  });

  thresholdSlider.addEventListener('input', () => {
    const db = parseFloat(thresholdSlider.value);
    engine.setThreshold(db);
    thresholdValue.textContent = `${db} dB`;
    // Update marker position: map [-80, -10] to [0%, 100%]
    const pct = ((db - (-80)) / ((-10) - (-80))) * 100;
    thresholdMarker.style.left = `${pct}%`;
  });

  holdTimeSlider.addEventListener('input', () => {
    const frames = parseInt(holdTimeSlider.value);
    engine.setHoldTime(frames);
    holdTimeValue.textContent = `${frames} frames`;
  });

  // Detection tuning sliders
  const debounceSlider = document.getElementById('debounce') as HTMLInputElement;
  const debounceValue = document.getElementById('debounce-value') as HTMLSpanElement;
  const confirmSlider = document.getElementById('confirm-frames') as HTMLInputElement;
  const confirmValue = document.getElementById('confirm-frames-value') as HTMLSpanElement;
  const secondConfSlider = document.getElementById('second-confidence') as HTMLInputElement;
  const secondConfValue = document.getElementById('second-confidence-value') as HTMLSpanElement;
  const subtractionSlider = document.getElementById('subtraction') as HTMLInputElement;
  const subtractionValue = document.getElementById('subtraction-value') as HTMLSpanElement;
  const harmonicRejectSlider = document.getElementById('harmonic-reject') as HTMLInputElement;
  const harmonicRejectValue = document.getElementById('harmonic-reject-value') as HTMLSpanElement;

  debounceSlider.addEventListener('input', () => {
    const ms = parseInt(debounceSlider.value);
    engine.setDebounceMs(ms);
    debounceValue.textContent = `${ms}`;
  });

  confirmSlider.addEventListener('input', () => {
    const frames = parseInt(confirmSlider.value);
    engine.setConfirmFrames(frames);
    confirmValue.textContent = `${frames}`;
  });

  secondConfSlider.addEventListener('input', () => {
    const val = parseFloat(secondConfSlider.value);
    engine.setSecondNoteConfidence(val);
    secondConfValue.textContent = val.toFixed(2);
  });

  subtractionSlider.addEventListener('input', () => {
    const val = parseFloat(subtractionSlider.value);
    engine.setSubtractionStrength(val);
    subtractionValue.textContent = val.toFixed(2);
  });

  harmonicRejectSlider.addEventListener('input', () => {
    const cents = parseInt(harmonicRejectSlider.value);
    engine.setHarmonicRejectCents(cents);
    harmonicRejectValue.textContent = `${cents}`;
  });

  // State updates
  engine.setStateCallback((state: AudioEngineState) => {
    // Level meter
    const clampedDb = Math.max(-80, Math.min(-10, state.peakDb));
    const pct = ((clampedDb - (-80)) / ((-10) - (-80))) * 100;
    levelBar.style.width = `${pct}%`;
    levelBar.classList.toggle('gate-open', state.gateOpen);
    levelDb.textContent = state.peakDb > -Infinity
      ? `${state.peakDb.toFixed(0)} dB`
      : '— dB';

    // Status indicator shows detection phase
    if (state.isRunning) {
      const phaseLabels = {
        idle: 'Listening — play a note...',
        single: 'Note locked — play the second note...',
        interval: 'Interval detected',
      };
      statusIndicator.textContent = phaseLabels[state.phase];
      statusIndicator.className = state.phase === 'interval'
        ? 'status active'
        : state.phase === 'single'
          ? 'status single'
          : 'status active';
    }

    // Notes
    if (state.notes.length === 0) {
      notesDisplay.textContent = '—';
    } else {
      notesDisplay.textContent = state.notes
        .map(n => `${midiToNoteName(n.midi)} (${n.frequency.toFixed(1)} Hz)`)
        .join('  +  ');
    }

    // Interval
    intervalDisplay.textContent = state.intervalLabel || '—';

    // Filter
    if (state.activeFilterFreq) {
      filterDisplay.textContent =
        `Bandpass: ${state.activeFilterFreq.toFixed(1)} Hz (Q=${state.activeFilterQ})`;
      filterDisplay.className = 'filter-info active';
    } else {
      filterDisplay.textContent = 'No filter active';
      filterDisplay.className = 'filter-info';
    }

    // Coincident partials table
    if (state.coincidentPartials.length === 0) {
      partialsTable.innerHTML = '<tr><td colspan="5">Play two notes to see coincident partials</td></tr>';
    } else {
      partialsTable.innerHTML = state.coincidentPartials.map((cp, i) => `
        <tr class="partial-row${state.activeFilterFreq &&
          Math.abs(state.activeFilterFreq - cp.centerFreq) < 1 ? ' active' : ''}"
            data-index="${i}">
          <td>${cp.m}:${cp.n}</td>
          <td>${cp.freq1.toFixed(1)}</td>
          <td>${cp.freq2.toFixed(1)}</td>
          <td>${cp.centerFreq.toFixed(1)}</td>
          <td>${cp.beatRate.toFixed(2)}</td>
        </tr>
      `).join('');

      // Click to select which partial to filter
      partialsTable.querySelectorAll('.partial-row').forEach(row => {
        row.addEventListener('click', () => {
          const idx = parseInt((row as HTMLElement).dataset.index || '0');
          engine.selectPartial(idx);
        });
      });
    }
  });
}

// Note name helper (duplicated here to avoid import complexity in UI)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiToNoteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
