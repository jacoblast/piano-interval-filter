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

  // State updates
  engine.setStateCallback((state: AudioEngineState) => {
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
