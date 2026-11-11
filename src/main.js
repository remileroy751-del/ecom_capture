'use strict';
const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, shell,
  screen, globalShortcut, Tray, Menu, nativeImage, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

app.setAppUserModelId('com.ecomcapture.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');

let settings = null;
let settingsFile = '';
let mainWindow = null;
let toolbarWin = null;
let camWin = null;
let countdownWin = null;
let tray = null;
let recState = { state: 'idle', elapsedMs: 0 };
let pending = { sourceId: null, displayId: null, systemAudio: false };
let forceQuit = false;
let countdownCanceled = false;
let camPos = null;
let streamSeq = 0;
let jobSeq = 0;
const streams = new Map();
const jobs = new Map();

/* ------------------------------------------------------------------ */
/* Textes (menu de la zone de notification, boîtes de dialogue)         */
/* ------------------------------------------------------------------ */
const TEXT = {
  fr: {
    show: 'Afficher Ecom Capture',
    start: 'Démarrer l’enregistrement (F9)',
    stop: 'Arrêter l’enregistrement (F9)',
    pause: 'Pause / Reprendre (F10)',
    quit: 'Quitter',
    ok: 'OK',
    cancel: 'Annuler',
    quitAnyway: 'Quitter quand même',
    quitRec: 'Un enregistrement est en cours. Arrêtez-le avant de quitter.',
    quitJobs: 'Une conversion est en cours. Si vous quittez maintenant, le fichier WebM d’origine sera conservé mais ne sera pas converti en MP4.',
    pickFolder: 'Choisir le dossier d’enregistrement',
    doneTitle: 'Enregistrement prêt',
    doneBody: 'Cliquez pour afficher le fichier dans son dossier.'
  },
  en: {
    show: 'Show Ecom Capture',
    start: 'Start recording (F9)',
    stop: 'Stop recording (F9)',
    pause: 'Pause / Resume (F10)',
    quit: 'Quit',
    ok: 'OK',
    cancel: 'Cancel',
    quitAnyway: 'Quit anyway',
    quitRec: 'A recording is in progress. Stop it before quitting.',
    quitJobs: 'A conversion is in progress. If you quit now, the original WebM file is kept but will not be converted to MP4.',
    pickFolder: 'Choose the recording folder',
    doneTitle: 'Recording ready',
    doneBody: 'Click to show the file in its folder.'
  }
};
const L = () => TEXT[settings && settings.language] || TEXT.fr;

/* ------------------------------------------------------------------ */
/* Réglages                                                            */
/* ------------------------------------------------------------------ */
function defaults() {
  return {
    language: 'fr',
    theme: 'dark',
    outputDir: path.join(app.getPath('videos'), 'Ecom Capture'),
    fps: 30,
    quality: 'high',
    resolution: 'native',
    outputMode: 'edit',
    micEnabled: true,
    micDeviceId: '',
    micGain: 1,
    noiseSuppression: true,
    echoCancellation: true,
    autoGain: false,
    systemAudio: false,
    separateMic: false,
    camEnabled: false,
    camDeviceId: '',
    camSize: 'm',
    camMirror: true,
    countdown: 3,
    autoStopMin: 0,
    keepOriginal: false
  };
}

function loadSettings() {
  const base = defaults();
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    for (const k of Object.keys(base)) {
      if (raw[k] !== undefined && typeof raw[k] === typeof base[k]) base[k] = raw[k];
    }
  } catch (_) { /* premier lancement */ }
  return base;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (_) { /* ignoré */ }
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignoré */ }
  return dir;
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (w) => w && !w.isDestroyed();

function targetDisplay() {
  const all = screen.getAllDisplays();
  if (pending.displayId) {
    const d = all.find((x) => String(x.id) === String(pending.displayId));
    if (d) return d;
  }
  if (alive(mainWindow)) {
    try { return screen.getDisplayMatching(mainWindow.getBounds()); } catch (_) { /* ignoré */ }
  }
  return screen.getPrimaryDisplay();
}

function insideArea(area, p) {
  return p.x >= area.x && p.y >= area.y && p.x <= area.x + area.width - 60 && p.y <= area.y + area.height - 60;
}

function insideOutputDir(p) {
  if (typeof p !== 'string') return false;
  const dir = path.resolve(settings.outputDir);
  return path.resolve(path.dirname(p)).toLowerCase() === dir.toLowerCase();
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, -ext.length);
  let i = 1;
  while (fs.existsSync(`${base}_${i}${ext}`)) i++;
  return `${base}_${i}${ext}`;
}

function sendToMain(channel, payload) {
  if (alive(mainWindow)) mainWindow.webContents.send(channel, payload);
}

function showMain() {
  if (!alive(mainWindow)) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Les actions venant des raccourcis / de la barre flottante sont exécutées
// "avec geste utilisateur" : Chromium l'exige pour démarrer la capture d'écran.
function control(action) {
  if (!alive(mainWindow)) return;
  mainWindow.webContents
    .executeJavaScript(`window.__recControl && window.__recControl(${JSON.stringify(action)})`, true)
    .catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Fenêtres                                                            */
/* ------------------------------------------------------------------ */
function createMain() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Ecom Capture',
    icon: path.join(ASSETS, 'icon.ico'),
    backgroundColor: settings.theme === 'light' ? '#eef1f5' : '#12151b',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  // La fenêtre du logiciel n'apparaît jamais dans les enregistrements.
  mainWindow.setContentProtection(true);
  mainWindow.loadFile(path.join(RENDERER, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (forceQuit) return;
    if (recState.state !== 'idle') {
      e.preventDefault();
      showMain();
      dialog.showMessageBoxSync(mainWindow, { type: 'warning', message: L().quitRec, buttons: [L().ok] });
      return;
    }
    if (jobs.size > 0) {
      const r = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', message: L().quitJobs,
        buttons: [L().cancel, L().quitAnyway], defaultId: 0, cancelId: 0
      });
      if (r === 0) { e.preventDefault(); return; }
      killJobs();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    [toolbarWin, camWin, countdownWin].forEach((w) => { if (alive(w)) w.destroy(); });
  });
}

function sendToolbarState() {
  if (!alive(toolbarWin)) return;
  toolbarWin.webContents.send('toolbar:state', {
    state: recState.state, elapsedMs: recState.elapsedMs, lang: settings.language
  });
}

function openToolbar() {
  if (alive(toolbarWin)) return;
  const d = targetDisplay();
  const w = 244, h = 60;
  toolbarWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round(d.workArea.x + d.workArea.width / 2 - w / 2),
    y: d.workArea.y + 14,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false }
  });
  toolbarWin.setContentProtection(true);
  toolbarWin.setAlwaysOnTop(true, 'screen-saver');
  toolbarWin.loadFile(path.join(RENDERER, 'toolbar.html'));
  toolbarWin.webContents.once('did-finish-load', () => {
    if (!alive(toolbarWin)) return;
    toolbarWin.showInactive();
    sendToolbarState();
  });
  toolbarWin.on('closed', () => { toolbarWin = null; });
}

function closeToolbar() {
  if (alive(toolbarWin)) toolbarWin.destroy();
  toolbarWin = null;
}

function runCountdown(n) {
  return new Promise((resolve) => {
    if (!n || n < 1) return resolve(true);
    countdownCanceled = false;
    const d = targetDisplay();
    const size = 260;
    countdownWin = new BrowserWindow({
      width: size, height: size,
      x: Math.round(d.bounds.x + d.bounds.width / 2 - size / 2),
      y: Math.round(d.bounds.y + d.bounds.height / 2 - size / 2),
      frame: false, transparent: true, resizable: false, hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false }
    });
    countdownWin.setContentProtection(true);
    countdownWin.setIgnoreMouseEvents(true);
    countdownWin.setAlwaysOnTop(true, 'screen-saver');
    let finished = false;
    countdownWin.once('closed', () => { if (!finished) resolve(false); });
    countdownWin.loadFile(path.join(RENDERER, 'countdown.html'));
    countdownWin.webContents.once('did-finish-load', async () => {
      if (alive(countdownWin)) countdownWin.showInactive();
      for (let i = n; i > 0; i--) {
        if (countdownCanceled || !alive(countdownWin)) break;
        countdownWin.webContents.send('countdown:n', i);
        await sleep(1000);
      }
      const ok = !countdownCanceled && alive(countdownWin);
      finished = true;
      if (alive(countdownWin)) countdownWin.destroy();
      countdownWin = null;
      resolve(ok);
    });
  });
}

function camSizePx() {
  return { s: 170, m: 250, l: 350 }[settings.camSize] || 250;
}

function hideCam() {
  if (alive(camWin)) camWin.destroy();
  camWin = null;
}

function showCam() {
  hideCam();
  const d = targetDisplay();
  const size = camSizePx();
  const wa = d.workArea;
  const pos = camPos && insideArea(wa, camPos)
    ? camPos
    : { x: wa.x + wa.width - size - 28, y: wa.y + wa.height - size - 28 };
  camWin = new BrowserWindow({
    width: size, height: size, x: pos.x, y: pos.y,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false }
  });
  camWin.setAlwaysOnTop(true, 'screen-saver');
  camWin.loadFile(path.join(RENDERER, 'webcam.html'), {
    query: { device: settings.camDeviceId || '', mirror: settings.camMirror ? '1' : '0' }
  });
  camWin.webContents.once('did-finish-load', () => { if (alive(camWin)) camWin.showInactive(); });
  camWin.on('moved', () => {
    if (!alive(camWin)) return;
    const b = camWin.getBounds();
    camPos = { x: b.x, y: b.y };
  });
  camWin.on('closed', () => { camWin = null; });
}

/* ------------------------------------------------------------------ */
/* Zone de notification (tray) et raccourcis globaux                    */
/* ------------------------------------------------------------------ */
function buildTray() {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.on('click', showMain);
    updateTray();
  } catch (_) { tray = null; }
}

function updateTray() {
  if (!tray) return;
  const idle = recState.state === 'idle';
  const active = recState.state === 'recording' || recState.state === 'paused';
  tray.setToolTip(idle ? 'Ecom Capture' : (recState.state === 'paused' ? 'Ecom Capture (pause)' : 'Ecom Capture (REC)'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: L().show, click: showMain },
    { label: idle ? L().start : L().stop, click: () => control('toggle') },
    { label: L().pause, enabled: active, click: () => control('pause-toggle') },
    { type: 'separator' },
    { label: L().quit, click: () => { if (alive(mainWindow)) mainWindow.close(); else app.quit(); } }
  ]));
}

function registerShortcuts() {
  try { globalShortcut.register('F9', () => control('toggle')); } catch (_) { /* ignoré */ }
  try { globalShortcut.register('F10', () => control('pause-toggle')); } catch (_) { /* ignoré */ }
}

/* ------------------------------------------------------------------ */
/* Session : permissions + capture d'écran                              */
/* ------------------------------------------------------------------ */
function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'display-capture');

  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const src = sources.find((s) => s.id === pending.sourceId) || sources.find((s) => s.id.startsWith('screen'));
      if (!src) return callback({});
      if (pending.systemAudio) callback({ video: src, audio: 'loopback' });
      else callback({ video: src });
    } catch (_) {
      callback({});
    }
  });
}

/* ------------------------------------------------------------------ */
/* IPC : réglages, sources, fichiers                                    */
/* ------------------------------------------------------------------ */
ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_e, patch) => {
  const base = defaults();
  for (const k of Object.keys(patch || {})) {
    if (k in base && typeof patch[k] === typeof base[k]) settings[k] = patch[k];
  }
  if (patch && patch.outputDir) ensureDir(settings.outputDir);
  saveSettings();
  if (patch && patch.language) updateTray();
  return settings;
});

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true
  });
  const own = new Set();
  [mainWindow, toolbarWin, camWin, countdownWin].forEach((w) => {
    if (alive(w)) { try { own.add(w.getMediaSourceId()); } catch (_) { /* ignoré */ } }
  });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return sources
    .filter((s) => !own.has(s.id))
    .filter((s) => s.id.startsWith('screen') || (s.name.trim() && !s.thumbnail.isEmpty()))
    .map((s) => {
      const isScreen = s.id.startsWith('screen');
      const d = isScreen ? displays.find((x) => String(x.id) === String(s.display_id)) : null;
      return {
        id: s.id,
        name: s.name,
        type: isScreen ? 'screen' : 'window',
        displayId: s.display_id || '',
        primary: !!d && d.id === primaryId,
        width: d ? Math.round(d.size.width * d.scaleFactor) : 0,
        height: d ? Math.round(d.size.height * d.scaleFactor) : 0,
        thumb: s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      };
    });
});

ipcMain.handle('source:select', (_e, o) => {
  pending.sourceId = o.id;
  pending.displayId = o.displayId || null;
  pending.systemAudio = !!o.systemAudio;
  if (alive(camWin)) {
    const cur = screen.getDisplayMatching(camWin.getBounds());
    if (String(cur.id) !== String(targetDisplay().id)) { camPos = null; showCam(); }
  }
  return true;
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: L().pickFolder,
    defaultPath: settings.outputDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.outputDir = ensureDir(r.filePaths[0]);
  saveSettings();
  return settings.outputDir;
});

ipcMain.handle('shell:open-folder', () => shell.openPath(ensureDir(settings.outputDir)));
ipcMain.handle('shell:open', (_e, p) => (insideOutputDir(p) ? shell.openPath(p) : null));
ipcMain.handle('shell:show', (_e, p) => { if (insideOutputDir(p)) shell.showItemInFolder(p); return true; });

ipcMain.handle('recordings:list', async () => {
  const dir = settings.outputDir;
  let files = [];
  try { files = await fs.promises.readdir(dir); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    if (!/\.(mp4|webm|mp3)$/i.test(f)) continue;
    const p = path.join(dir, f);
    let st = null;
    try { st = await fs.promises.stat(p); } catch (_) { /* ignoré */ }
    if (st && st.isFile()) {
      out.push({ name: f, path: p, size: st.size, mtime: st.mtimeMs, ext: path.extname(f).slice(1).toLowerCase() });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 300);
});

ipcMain.handle('recordings:delete', async (_e, p) => {
  if (!insideOutputDir(p)) return false;
  try { await shell.trashItem(p); return true; } catch (_) { return false; }
});

/* ------------------------------------------------------------------ */
/* IPC : écriture progressive des enregistrements                       */
/* ------------------------------------------------------------------ */
ipcMain.handle('rec:open', (_e, { base, kind }) => {
  const dir = ensureDir(settings.outputDir);
  const safe = String(base || 'Capture').replace(/[^\w\-. ]/g, '_');
  const file = uniquePath(path.join(dir, kind === 'mic' ? `${safe}_micro.webm` : `${safe}.webm`));
  const stream = fs.createWriteStream(file);
  const entry = { stream, file, error: null };
  stream.on('error', (err) => { entry.error = err.message; });
  const id = ++streamSeq;
  streams.set(id, entry);
  return { id, file };
});

ipcMain.on('rec:chunk', (_e, id, data) => {
  const s = streams.get(id);
  if (s && !s.error) s.stream.write(Buffer.from(data));
});

ipcMain.handle('rec:close', (_e, id) => new Promise((resolve) => {
  const s = streams.get(id);
  if (!s) return resolve(null);
  streams.delete(id);
  s.stream.end(() => resolve(s.error ? null : s.file));
}));

ipcMain.on('rec:state', (_e, st) => {
  recState = { state: st.state, elapsedMs: st.elapsedMs || 0 };
  sendToolbarState();
  updateTray();
});

/* ------------------------------------------------------------------ */
/* IPC : interface pendant l'enregistrement                             */
/* ------------------------------------------------------------------ */
ipcMain.handle('ui:enter', () => { if (alive(mainWindow)) mainWindow.minimize(); return true; });
ipcMain.handle('ui:toolbar', () => { openToolbar(); return true; });
ipcMain.handle('ui:exit', () => { closeToolbar(); showMain(); return true; });
ipcMain.handle('countdown:run', (_e, n) => runCountdown(Number(n) || 0));
ipcMain.on('countdown:cancel', () => {
  countdownCanceled = true;
  if (alive(countdownWin)) countdownWin.destroy();
});
ipcMain.on('toolbar:action', (_e, action) => {
  if (action === 'pause-toggle' || action === 'stop') control(action);
});

ipcMain.handle('cam:sync', () => {
  if (settings.camEnabled) showCam(); else hideCam();
  return true;
});
ipcMain.on('cam:close', () => {
  hideCam();
  settings.camEnabled = false;
  saveSettings();
  sendToMain('settings:changed', settings);
});

/* ------------------------------------------------------------------ */
/* Conversion FFmpeg (WebM -> MP4 / MP3)                                */
/* ------------------------------------------------------------------ */
function ffmpegBinary() {
  const p = require('ffmpeg-static');
  return String(p).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
}

function runFfmpeg(jobId, args, onTime) {
  return new Promise((resolve, reject) => {
    const job = jobs.get(jobId);
    let proc;
    try {
      proc = spawn(ffmpegBinary(), args, { windowsHide: true });
    } catch (err) { return reject(err); }
    if (job) job.proc = proc;
    let log = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      log = (log + s).slice(-3000);
      const re = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
      let m, last = null;
      while ((m = re.exec(s))) last = m;
      if (last && onTime) onTime(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (code ${code})\n${log}`));
    });
  });
}

function killJobs() {
  for (const j of jobs.values()) {
    j.killed = true;
    try { if (j.proc) j.proc.kill(); } catch (_) { /* ignoré */ }
  }
}

async function runConvert(id, o) {
  const job = jobs.get(id);
  const opts = o.opts || {};
  const input = o.input;
  const kind = o.kind === 'mic' ? 'mic' : 'screen';
  try {
    if (!insideOutputDir(input) || !fs.existsSync(input)) throw new Error('Fichier introuvable');
    const output = uniquePath(input.replace(/\.webm$/i, kind === 'mic' ? '.mp3' : '.mp4'));
    const total = (Number(o.durationMs) || 0) / 1000;
    const onTime = (sec) => {
      sendToMain('convert:progress', { id, percent: total > 0 ? Math.min(99, Math.round((sec / total) * 100)) : -1 });
    };

    if (kind === 'mic') {
      await runFfmpeg(id, ['-y', '-hide_banner', '-i', input, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', output], onTime);
    } else {
      const fps = [24, 30, 60].includes(Number(opts.fps)) ? Number(opts.fps) : 30;
      const crf = { standard: 23, high: 20, max: 17 }[opts.quality] || 20;
      const maxH = { '1080': 1080, '720': 720 }[opts.resolution];
      const scale = maxH ? `scale=-2:'min(${maxH},ih)'` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
      const encode = [
        '-y', '-hide_banner', '-i', input,
        '-vf', `fps=${fps},${scale}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output
      ];
      const copy = [
        '-y', '-hide_banner', '-i', input,
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output
      ];
      const wantCopy = opts.mode === 'fast' && !!o.h264 && !maxH;
      const attempts = wantCopy ? [copy, encode] : (o.h264 ? [encode, copy] : [encode]);
      let lastErr = null;
      for (const args of attempts) {
        try { await runFfmpeg(id, args, onTime); lastErr = null; break; }
        catch (err) {
          lastErr = err;
          try { fs.unlinkSync(output); } catch (_) { /* ignoré */ }
          if (job && job.killed) break;
        }
      }
      if (lastErr) throw lastErr;
    }

    if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('Fichier de sortie vide');
    if (!opts.keepOriginal) { try { fs.unlinkSync(input); } catch (_) { /* ignoré */ } }
    sendToMain('convert:done', { id, ok: true, kind, input, output });
    if (kind === 'screen' && Notification.isSupported()) {
      const n = new Notification({ title: L().doneTitle, body: L().doneBody, icon: path.join(ASSETS, 'icon.png') });
      n.on('click', () => shell.showItemInFolder(output));
      n.show();
    }
  } catch (err) {
    sendToMain('convert:done', { id, ok: false, kind, input, error: String(err && err.message || err).slice(0, 600) });
  } finally {
    jobs.delete(id);
  }
}

ipcMain.handle('convert:start', (_e, o) => {
  const id = ++jobSeq;
  jobs.set(id, { proc: null, killed: false });
  runConvert(id, o);
  return { id };
});

/* ------------------------------------------------------------------ */
/* Cycle de vie                                                         */
/* ------------------------------------------------------------------ */
app.on('second-instance', showMain);

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  settings = loadSettings();
  ensureDir(settings.outputDir);
  Menu.setApplicationMenu(null);
  setupSession();
  createMain();
  buildTray();
  registerShortcuts();
});

app.on('before-quit', () => { forceQuit = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { app.quit(); });
