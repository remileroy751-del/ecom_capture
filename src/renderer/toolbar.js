'use strict';
const TXT = {
  fr: { pause: 'Pause (F10)', resume: 'Reprendre (F10)', stop: 'Arrêter (F9)' },
  en: { pause: 'Pause (F10)', resume: 'Resume (F10)', stop: 'Stop (F9)' }
};
const ICON_PAUSE = '<svg viewBox="0 0 16 16"><rect x="3" y="2.5" width="3.5" height="11" rx="1"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4.5 2.7v10.6a.7.7 0 0 0 1.07.6l8.2-5.3a.7.7 0 0 0 0-1.2L5.57 2.1a.7.7 0 0 0-1.07.6z"/></svg>';

let state = 'recording';
let elapsed = 0;
let since = performance.now();
let lang = 'fr';

const pill = document.getElementById('pill');
const timeEl = document.getElementById('time');
const pauseBtn = document.getElementById('pause');
const stopBtn = document.getElementById('stop');

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function render() {
  const now = state === 'recording' ? elapsed + (performance.now() - since) : elapsed;
  timeEl.textContent = fmt(now);
  const t = TXT[lang] || TXT.fr;
  const paused = state === 'paused';
  pill.classList.toggle('rec', !paused);
  pill.classList.toggle('paused', paused);
  pauseBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
  const label = paused ? t.resume : t.pause;
  pauseBtn.title = label;
  pauseBtn.setAttribute('aria-label', label);
  stopBtn.title = t.stop;
  stopBtn.setAttribute('aria-label', t.stop);
}

window.api.onToolbarState((s) => {
  state = s.state;
  elapsed = s.elapsedMs || 0;
  since = performance.now();
  lang = s.lang || lang;
  render();
});

pauseBtn.addEventListener('click', () => window.api.toolbarAction('pause-toggle'));
stopBtn.addEventListener('click', () => window.api.toolbarAction('stop'));
setInterval(render, 250);
render();
