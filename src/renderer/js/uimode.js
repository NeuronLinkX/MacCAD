/**
 * @file uimode.js
 * @brief Interface mode: "Advanced" (small icons, the classic look) or "Beginner" (big icons with
 * the name under each icon). Chosen on the first start, changed later with `UIMODE`.
 */
import { def } from './registry.js';
import { dialog } from './dialogs.js';

const MODES = {
  advanced: { label: 'Advanced mode', ko: '고급 모드', text: 'Small icons, more room for the drawing. Made for people who know CAD.' },
  beginner: { label: 'Beginner mode', ko: '초보자 모드', text: 'Big icons with the name written under each one, so every button can be read.' },
};

/** Short name for the label under an icon: the tool tip without brackets and dots. */
const shortLabel = (title) =>
  String(title || '')
    .replace(/\(.*?\)/g, '')
    .replace(/\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Applies the mode of `app.settings.uiMode` to the window. */
export function applyUiMode(app) {
  applyTheme(app);
  const beginner = app.settings.uiMode === 'beginner';
  document.body.classList.toggle('beginner', beginner);
  document.querySelectorAll('.tb[title]').forEach((b) => {
    if (!b.dataset.label) b.dataset.label = shortLabel(b.title);
  });
  app.redraw();
}

/** Changes the mode, remembers it and applies it. */
export function setUiMode(app, mode) {
  if (!MODES[mode]) return false;
  app.settings.uiMode = mode;
  app.settings.uiModeChosen = true;
  app.saveSettings();
  applyUiMode(app);
  app.emit('settings');
  return true;
}

/** The first-start question: two big cards. @returns {Promise<string>} the chosen mode */
export async function chooseUiMode(app) {
  let picked = app.settings.uiMode || 'advanced';
  const card = (mode) => {
    const el = document.createElement('div');
    el.className = `uim-card${picked === mode ? ' on' : ''}`;
    el.innerHTML = `<b>${MODES[mode].ko}</b><i>${MODES[mode].label}</i><span>${MODES[mode].text}</span>`;
    el.onclick = () => {
      picked = mode;
      el.parentElement.querySelectorAll('.uim-card').forEach((c) => c.classList.toggle('on', c === el));
    };
    return el;
  };
  const body = document.createElement('div');
  body.className = 'uim';
  body.append(card('beginner'), card('advanced'));
  await dialog({
    title: 'Choose your mode (초보자 모드 / 고급 모드)',
    body,
    buttons: [{ label: 'OK', value: true, primary: true }],
  });
  setUiMode(app, picked);
  return picked;
}

def('UIMODE INTERFACEMODE', async (c) => {
  const cur = c.app.settings.uiMode === 'beginner' ? 'Beginner' : 'Advanced';
  const o = await c.keyword(`Enter an interface mode [Beginner/Advanced] <${cur}>`, ['Beginner', 'Advanced'], cur);
  if (!o) return;
  setUiMode(c.app, o.toLowerCase());
  c.echo(`Interface mode: ${o}.`);
});

const THEMES = ['system', 'light', 'dark'];

/** Applies the colour theme: follow the Mac, or light, or dark. */
export function applyTheme(app) {
  const t = THEMES.includes(app.settings.theme) ? app.settings.theme : 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  app.redraw();
}

/** Sets the theme and remembers it. */
export function setTheme(app, t) {
  if (!THEMES.includes(t)) return false;
  app.settings.theme = t;
  app.saveSettings();
  applyTheme(app);
  app.emit('settings');
  return true;
}

def('THEME', async (c) => {
  const cur = c.app.settings.theme || 'system';
  const o = await c.keyword(`Enter a colour theme [System/Light/Dark] <${cur}>`, ['System', 'Light', 'Dark'], cur);
  if (!o) return;
  setTheme(c.app, o.toLowerCase());
  c.echo(`Theme: ${o}.`);
});
