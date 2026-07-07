import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings.js';

const FIELDS = [
  'format',
  'jpegQuality',
  'pdfPaper',
  'filenameTemplate',
  'afterCapture',
  'captureDelay',
  'hideFixed',
  'hideScrollbars',
  'maxCaptureHeight',
];

const $ = (id) => document.getElementById(id);

let saveTimer = null;
let stateTimer = null;

function readForm() {
  const s = {};
  for (const key of FIELDS) {
    const el = $(key);
    if (el.type === 'checkbox') s[key] = el.checked;
    else if (el.type === 'number' || el.type === 'range') s[key] = Number(el.value);
    else s[key] = el.value;
  }
  return s;
}

function fillForm(s) {
  for (const key of FIELDS) {
    const el = $(key);
    if (el.type === 'checkbox') el.checked = Boolean(s[key]);
    else el.value = s[key];
  }
  $('jpegQuality-val').textContent = `${s.jpegQuality}%`;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(readForm());
    const el = $('save-state');
    el.textContent = 'Saved';
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => (el.textContent = ''), 1500);
  }, 250);
}

async function init() {
  fillForm(await loadSettings());

  for (const key of FIELDS) {
    $(key).addEventListener('input', () => {
      if (key === 'jpegQuality') {
        $('jpegQuality-val').textContent = `${$('jpegQuality').value}%`;
      }
      scheduleSave();
    });
  }

  $('reset').addEventListener('click', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS });
    fillForm(DEFAULT_SETTINGS);
    $('save-state').textContent = 'Defaults restored';
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => ($('save-state').textContent = ''), 1500);
  });
}

init();
