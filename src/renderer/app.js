'use strict';
(() => {
  const api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------------------------------------------------------------- */
  /* Outils                                                            */
  /* ---------------------------------------------------------------- */
  let S = {};
  let lang = 'fr';

  const t = (key, vars) => {
    const dict = window.I18N;
    let s = (dict[lang] && dict[lang][key]) || dict.fr[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };

  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  const pad = (n) => String(n).padStart(2, '0');
  const fmtClock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  };
  const fmtBytes = (n) => {
    const u = lang === 'fr' ? ['Ko', 'Mo', 'Go'] : ['KB', 'MB', 'GB'];
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' ' + u[0];
    if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' ' + u[1];
    return (n / 1024 ** 3).toFixed(2) + ' ' + u[2];
  };

  let toastTimer = 0;
  function toast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 6500);
  }

  const ICON_PAUSE = '<rect x="3" y="2.5" width="3.5" height="11" rx="1"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1"/>';
  const ICON_PLAY = '<path d="M4.5 2.7v10.6a.7.7 0 0 0 1.07.6l8.2-5.3a.7.7 0 0 0 0-1.2L5.57 2.1a.7.7 0 0 0-1.07.6z"/>';

  /* ---------------------------------------------------------------- */
  /* État                                                              */
  /* ---------------------------------------------------------------- */
  let sources = [];
  let selectedSource = null;
  let filter = 'screen';
  let devices = { mics: [], cams: [] };
  let library = [];
  let lastResult = null;
  let cancelStart = false;
  const rec = { state: 'idle' };
  let session = null;
  const jobs = new Map();
  const doneIds = new Set();

  // audio
  let audioCtx = null, mixDest = null, micOnlyDest = null;
  let micStream = null, micSrc = null, micGainNode = null, analyser = null;
  let micSeq = 0, meterRAF = 0;
  const VU_SEGMENTS = 24;

  /* ---------------------------------------------------------------- */
  /* Réglages <-> interface                                            */
  /* ---------------------------------------------------------------- */
  function syncUI() {
    $$('[data-setting]').forEach((el) => {
      const k = el.dataset.setting;
      const v = S[k];
      if (el.classList.contains('seg')) {
        $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
      } else if (el.type === 'checkbox') {
        el.checked = !!v;
      } else if (v !== undefined) {
        el.value = String(v);
      }
    });
    $('#gainOut').textContent = Math.round((S.micGain || 0) * 100) + ' %';
    $('#micFields').toggleAttribute('inert', !S.micEnabled);
    $('#camFields').toggleAttribute('inert', !S.camEnabled);
    const fp = $('#folderPath');
    fp.textContent = S.outputDir || '';
    fp.title = S.outputDir || '';
    const hintKey = { edit: 'fmtEditHint', fast: 'fmtFastHint', raw: 'fmtRawHint' }[S.outputMode];
    $('#fmtHint').textContent = hintKey ? t(hintKey) : '';
    $$('#langSeg button').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  }

  function readValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.dataset.type === 'number') return Number(el.value);
    return el.value;
  }

  async function commit(key, val) {
    S[key] = val;
    S = await api.setSettings({ [key]: val });
    await onSettingChanged(key);
    syncUI();
  }

  async function onSettingChanged(key) {
    switch (key) {
      case 'theme': applyTheme(); break;
      case 'language': applyLang(); break;
      case 'micEnabled': case 'micDeviceId': case 'noiseSuppression':
      case 'echoCancellation': case 'autoGain':
        if (rec.state === 'idle') await openMic();
        break;
      case 'camEnabled':
        if (S.camEnabled) await primeCamLabels();
        await api.camSync();
        break;
      case 'camDeviceId': case 'camSize': case 'camMirror':
        if (S.camEnabled) await api.camSync();
        break;
      default: break;
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = S.theme === 'light' ? 'light' : 'dark';
  }

  function applyLang() {
    lang = S.language === 'en' ? 'en' : 'fr';
    document.documentElement.lang = lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-title]').forEach((el) => {
      const v = t(el.dataset.i18nTitle);
      el.title = v;
      el.setAttribute('aria-label', v);
    });
    renderSources();
    renderDevices();
    renderLibrary();
    renderMeterLabel();
    updateRecUI();
    renderStatus();
    syncUI();
  }

  function bindSettings() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.seg[data-setting] button');
      if (!b) return;
      const seg = b.parentElement;
      let v = b.dataset.v;
      if (seg.dataset.type === 'number') v = Number(v);
      commit(seg.dataset.setting, v);
    });

    document.addEventListener('input', (e) => {
      const el = e.target;
      if (el.matches && el.matches('input[type="range"][data-setting]')) {
        S[el.dataset.setting] = Number(el.value);
        if (el.dataset.setting === 'micGain' && micGainNode) micGainNode.gain.value = S.micGain;
        $('#gainOut').textContent = Math.round(S.micGain * 100) + ' %';
      }
    });

    document.addEventListener('change', (e) => {
      const el = e.target.closest && e.target.closest('[data-setting]');
      if (!el || el.classList.contains('seg')) return;
      commit(el.dataset.setting, readValue(el));
    });

    $$('#langSeg button').forEach((b) => b.addEventListener('click', () => commit('language', b.dataset.lang)));
    $('#themeBtn').addEventListener('click', () => commit('theme', S.theme === 'light' ? 'dark' : 'light'));

    $('#changeFolder').addEventListener('click', async () => {
      const dir = await api.pickFolder();
      if (dir) { S.outputDir = dir; syncUI(); refreshLibrary(); }
    });
    $('#openFolder').addEventListener('click', () => api.openFolder());
    $('#libFolder').addEventListener('click', () => api.openFolder());
    $('#libRefresh').addEventListener('click', () => refreshLibrary());

    $$('.tab').forEach((b) => b.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('on', x === b));
      $('#tab-capture').hidden = b.dataset.tab !== 'capture';
      $('#tab-library').hidden = b.dataset.tab !== 'library';
      if (b.dataset.tab === 'library') refreshLibrary();
    }));

    $$('#filterSeg button').forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.filter;
      renderSources();
    }));
    $('#refreshSources').addEventListener('click', () => refreshSources());

    $('#recBtn').addEventListener('click', () => window.__recControl('toggle'));
    $('#pauseBtn').addEventListener('click', () => togglePause());
  }

  /* ---------------------------------------------------------------- */
  /* Sources (écrans / fenêtres)                                       */
  /* ---------------------------------------------------------------- */
  async function refreshSources() {
    try { sources = await api.listSources(); } catch (_) { sources = []; }
    const keep = selectedSource && sources.find((s) => s.id === selectedSource.id);
    selectedSource = keep || sources.find((s) => s.type === 'screen') || sources[0] || null;
    if (selectedSource) {
      filter = filter === selectedSource.type || keep ? filter : selectedSource.type;
      api.selectSource({ id: selectedSource.id, displayId: selectedSource.displayId, systemAudio: !!S.systemAudio });
    }
    renderSources();
  }

  function chooseSource(s) {
    selectedSource = s;
    api.selectSource({ id: s.id, displayId: s.displayId, systemAudio: !!S.systemAudio });
    renderSources();
  }

  function renderSources() {
    const grid = $('#sourceGrid');
    grid.replaceChildren();
    $$('#filterSeg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
    const list = sources.filter((s) => s.type === filter);
    if (!list.length) {
      grid.append(h('div', { class: 'empty' }, t('noSources')));
      return;
    }
    let n = 0;
    for (const s of list) {
      const on = !!selectedSource && selectedSource.id === s.id;
      let name = s.name;
      let sub = '';
      if (s.type === 'screen') {
        n += 1;
        name = t('screenN', { n }) + (s.primary ? ' (' + t('primary') + ')' : '');
        sub = s.width ? `${s.width} × ${s.height}` : '';
      }
      grid.append(
        h('button', { class: 'src' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), title: s.name, onclick: () => chooseSource(s) },
          h('span', { class: 'shot' }, h('img', { src: s.thumb, alt: '' })),
          h('span', { class: 'cap' },
            s.icon ? h('img', { src: s.icon, alt: '' }) : null,
            h('span', { class: 'nm' }, name),
            sub ? h('span', { class: 'sub' }, sub) : null))
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Périphériques audio / vidéo                                       */
  /* ---------------------------------------------------------------- */
  async function refreshDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (_) { /* ignoré */ }
    const real = (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
    devices = {
      mics: list.filter((d) => d.kind === 'audioinput' && real(d)),
      cams: list.filter((d) => d.kind === 'videoinput' && real(d))
    };
    renderDevices();
  }

  function fillSelect(sel, items, current, labelKey) {
    sel.replaceChildren(h('option', { value: '' }, t('defaultDevice')));
    items.forEach((d, i) => sel.append(h('option', { value: d.deviceId }, d.label || t(labelKey, { n: i + 1 }))));
    sel.value = items.some((d) => d.deviceId === current) ? current : '';
  }

  function renderDevices() {
    fillSelect($('#micSelect'), devices.mics, S.micDeviceId, 'micN');
    fillSelect($('#camSelect'), devices.cams, S.camDeviceId, 'cameraN');
  }

  async function primeCamLabels() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((tk) => tk.stop());
    } catch (_) { /* la caméra peut être absente */ }
    await refreshDevices();
  }

  /* ---------------------------------------------------------------- */
  /* Microphone, mixage audio, vu-mètre                                */
  /* ---------------------------------------------------------------- */
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      mixDest = audioCtx.createMediaStreamDestination();
      micOnlyDest = audioCtx.createMediaStreamDestination();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function closeMic() {
    stopMeter();
    try { if (micSrc) micSrc.disconnect(); } catch (_) { /* ignoré */ }
    try { if (micGainNode) micGainNode.disconnect(); } catch (_) { /* ignoré */ }
    if (micStream) micStream.getTracks().forEach((tk) => tk.stop());
    micStream = micSrc = micGainNode = analyser = null;
  }

  async function openMic() {
    const my = ++micSeq;
    closeMic();
    renderMeterLabel();
    if (!S.micEnabled) return;
    const ask = (id) => navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: !!S.echoCancellation,
        noiseSuppression: !!S.noiseSuppression,
        autoGainControl: !!S.autoGain
      }
    });
    let stream = null;
    try {
      stream = await ask(S.micDeviceId);
    } catch (e) {
      if (S.micDeviceId) {
        try {
          stream = await ask('');
          S.micDeviceId = '';
          api.setSettings({ micDeviceId: '' });
        } catch (e2) { toast(t('errMic', { e: e2.message || e2.name }), 'error'); return; }
      } else {
        toast(t('errMic', { e: e.message || e.name }), 'error');
        return;
      }
    }
    if (my !== micSeq) { stream.getTracks().forEach((tk) => tk.stop()); return; }
    micStream = stream;
    ensureAudio();
    micSrc = audioCtx.createMediaStreamSource(micStream);
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = S.micGain;
    micSrc.connect(micGainNode);
    micGainNode.connect(mixDest);
    micGainNode.connect(micOnlyDest);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    micGainNode.connect(analyser);
    startMeter();
    await refreshDevices();
  }

  function buildVu() {
    const vu = $('#vu');
    for (let i = 0; i < VU_SEGMENTS; i++) {
      const cls = i >= VU_SEGMENTS * 0.88 ? 'hot' : (i >= VU_SEGMENTS * 0.7 ? 'warm' : '');
      vu.append(h('i', { class: cls }));
    }
  }

  function startMeter() {
    stopMeter();
    if (!analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    const segs = $$('#vu i');
    let level = 0;
    const loop = () => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = Math.abs(buf[i] - 128) / 128;
        if (d > peak) peak = d;
      }
      level = Math.max(peak, level * 0.88);
      const lit = Math.round(Math.min(1, Math.pow(level, 0.6) * 1.15) * VU_SEGMENTS);
      for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('lit', i < lit);
      meterRAF = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopMeter() {
    cancelAnimationFrame(meterRAF);
    $$('#vu i').forEach((el) => el.classList.remove('lit'));
  }

  function renderMeterLabel() {
    $('#meterLbl').textContent = S.micEnabled ? t('micLevel') : t('micOff');
    $('#vu').classList.toggle('off', !S.micEnabled);
  }

  /* ---------------------------------------------------------------- */
  /* Enregistrement                                                    */
  /* ---------------------------------------------------------------- */
  function pickMime() {
    const candidates = [
      ['video/webm;codecs=h264,opus', true],
      ['video/webm;codecs=avc1,opus', true],
      ['video/webm;codecs=vp9,opus', false],
      ['video/webm;codecs=vp8,opus', false],
      ['video/webm', false]
    ];
    for (const [type, h264] of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return { type, h264 };
    }
    return { type: 'video/webm', h264: false };
  }

  function videoBitrate() {
    const base = { standard: 6e6, high: 12e6, max: 24e6 }[S.quality] || 12e6;
    const f = S.fps >= 60 ? 1.6 : (S.fps <= 24 ? 0.85 : 1);
    return Math.round(base * f);
  }

  function elapsed() {
    if (!session) return 0;
    return session.base + (rec.state === 'recording' ? performance.now() - session.t0 : 0);
  }

  function tick() {
    $('#clock').textContent = fmtClock(elapsed());
    if (S.autoStopMin > 0 && rec.state === 'recording' && elapsed() >= S.autoStopMin * 60000) stopRecording();
  }

  function setRecState(st) {
    rec.state = st;
    document.body.dataset.rec = st;
    updateRecUI();
    renderStatus();
  }

  function updateRecUI() {
    const st = rec.state;
    $('#recLabel').textContent = st === 'idle' ? t('record') : (st === 'starting' ? t('cancel') : t('stop'));
    $('#recBtn').disabled = st === 'stopping';
    $('#pauseBtn').disabled = !(st === 'recording' || st === 'paused');
    $('#pauseLabel').textContent = st === 'paused' ? t('resume') : t('pause');
    $('#pauseIco').innerHTML = st === 'paused' ? ICON_PLAY : ICON_PAUSE;
  }

  function attachWriter(recorder, getId, chainKey, s) {
    recorder.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      const blob = ev.data;
      s[chainKey] = s[chainKey].then(async () => {
        api.recChunk(getId(), new Uint8Array(await blob.arrayBuffer()));
      }).catch(() => {});
    };
  }

  async function startRecording() {
    if (rec.state !== 'idle') return;
    if (!selectedSource) { toast(t('errPickSource'), 'warn'); return; }
    cancelStart = false;
    lastResult = null;
    setRecState('starting');
    api.recState({ state: 'starting', elapsedMs: 0 });

    // 1) Capture d'écran (doit être demandée tout de suite : geste utilisateur requis)
    let display = null;
    try {
      await api.selectSource({ id: selectedSource.id, displayId: selectedSource.displayId, systemAudio: !!S.systemAudio });
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: S.fps, max: S.fps } },
        audio: !!S.systemAudio
      });
    } catch (e) {
      setRecState('idle');
      api.recState({ state: 'idle', elapsedMs: 0 });
      toast(t('errCapture', { e: e.message || e.name }), 'error');
      return;
    }

    const abort = async () => {
      display.getTracks().forEach((tk) => tk.stop());
      await api.uiExit();
      setRecState('idle');
      api.recState({ state: 'idle', elapsedMs: 0 });
    };

    // 2) Fenêtre réduite + compte à rebours
    await api.uiEnter();
    const ok = await api.countdown(Number(S.countdown) || 0);
    if (!ok || cancelStart) { await abort(); return; }

    // 3) Mixage audio : micro + son de l'ordinateur
    ensureAudio();
    let sysNode = null;
    let hasAudio = false;
    let sysWarn = false;
    if (S.systemAudio) {
      const sysTrack = display.getAudioTracks()[0];
      if (sysTrack) {
        sysNode = audioCtx.createMediaStreamSource(new MediaStream([sysTrack]));
        sysNode.connect(mixDest);
        hasAudio = true;
      } else { sysWarn = true; }
    }
    const micActive = !!(S.micEnabled && micStream);
    if (micActive) hasAudio = true;
    const tracks = [...display.getVideoTracks()];
    if (hasAudio) tracks.push(mixDest.stream.getAudioTracks()[0]);
    const stream = new MediaStream(tracks);

    // 4) Enregistreurs + fichiers
    const mime = pickMime();
    const base = 'Capture_' + stamp();
    let recorder, mainFile;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: mime.type, videoBitsPerSecond: videoBitrate(), audioBitsPerSecond: 192000
      });
      mainFile = await api.recOpen({ base, kind: 'screen' });
    } catch (e) {
      await abort();
      toast(t('errCapture', { e: e.message || e.name }), 'error');
      return;
    }

    const s = {
      base: 0, t0: 0, display, sysNode, recorder, micRec: null, timer: 0,
      mainId: mainFile.id, mainFile: mainFile.file, micId: null, micFile: null,
      chain: Promise.resolve(), micChain: Promise.resolve(), h264: mime.h264
    };
    attachWriter(recorder, () => s.mainId, 'chain', s);

    if (S.separateMic && micActive) {
      try {
        const mf = await api.recOpen({ base, kind: 'mic' });
        s.micId = mf.id;
        s.micFile = mf.file;
        s.micRec = new MediaRecorder(micOnlyDest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
        attachWriter(s.micRec, () => s.micId, 'micChain', s);
      } catch (_) { s.micRec = null; }
    }

    // 5) Départ
    session = s;
    recorder.onerror = () => { toast(t('errWrite'), 'error'); stopRecording(); };
    recorder.start(1000);
    if (s.micRec) s.micRec.start(1000);
    s.t0 = performance.now();
    display.getVideoTracks()[0].addEventListener('ended', () => {
      if (session === s && (rec.state === 'recording' || rec.state === 'paused')) stopRecording();
    });
    setRecState('recording');
    api.recState({ state: 'recording', elapsedMs: 0 });
    await api.uiToolbar();
    s.timer = setInterval(tick, 250);
    tick();
    if (sysWarn) toast(t('warnNoSysAudio'), 'warn');
  }

  function togglePause() {
    if (!session) return;
    const now = performance.now();
    if (rec.state === 'recording') {
      session.recorder.pause();
      if (session.micRec) session.micRec.pause();
      session.base += now - session.t0;
      setRecState('paused');
      api.recState({ state: 'paused', elapsedMs: session.base });
    } else if (rec.state === 'paused') {
      session.recorder.resume();
      if (session.micRec) session.micRec.resume();
      session.t0 = now;
      setRecState('recording');
      api.recState({ state: 'recording', elapsedMs: session.base });
    }
  }

  async function stopRecording() {
    if (rec.state !== 'recording' && rec.state !== 'paused') return;
    const s = session;
    const durationMs = elapsed();
    clearInterval(s.timer);
    setRecState('stopping');
    api.recState({ state: 'stopping', elapsedMs: durationMs });

    const waitStop = (r) => new Promise((resolve) => {
      if (!r || r.state === 'inactive') return resolve();
      r.addEventListener('stop', () => resolve(), { once: true });
      try { r.stop(); } catch (_) { resolve(); }
    });
    await Promise.all([waitStop(s.recorder), waitStop(s.micRec)]);
    await s.chain;
    await s.micChain;

    s.display.getTracks().forEach((tk) => tk.stop());
    try { if (s.sysNode) s.sysNode.disconnect(); } catch (_) { /* ignoré */ }
    const file = await api.recClose(s.mainId);
    const micFile = s.micId ? await api.recClose(s.micId) : null;
    session = null;

    await api.uiExit();
    setRecState('idle');
    api.recState({ state: 'idle', elapsedMs: 0 });
    $('#clock').textContent = fmtClock(0);

    if (!file) { toast(t('errWrite'), 'error'); return; }
    const opts = {
      mode: S.outputMode, fps: S.fps, quality: S.quality, resolution: S.resolution, keepOriginal: !!S.keepOriginal
    };
    if (S.outputMode === 'raw') {
      lastResult = { path: file, raw: true };
      renderStatus();
    } else {
      startJob({ input: file, kind: 'screen', durationMs, h264: s.h264, opts });
    }
    if (micFile) startJob({ input: micFile, kind: 'mic', durationMs, h264: false, opts });
    refreshLibrary();
  }

  // Actions déclenchées par F9 / F10, la barre flottante ou l'icône de la zone de notification
  window.__recControl = (action) => {
    if (action === 'toggle') {
      if (rec.state === 'idle') startRecording();
      else if (rec.state === 'starting') { cancelStart = true; api.countdownCancel(); }
      else stopRecording();
    } else if (action === 'pause-toggle') {
      togglePause();
    } else if (action === 'stop') {
      stopRecording();
    }
  };

  /* ---------------------------------------------------------------- */
  /* Conversion MP4 / MP3                                              */
  /* ---------------------------------------------------------------- */
  async function startJob(o) {
    const { id } = await api.convertStart(o);
    if (doneIds.has(id)) { doneIds.delete(id); return; }
    jobs.set(id, { kind: o.kind, percent: 0 });
    renderStatus();
  }

  api.onConvertProgress(({ id, percent }) => {
    const j = jobs.get(id);
    if (j) { j.percent = percent; renderStatus(); }
  });

  api.onConvertDone(({ id, ok, kind, input, output }) => {
    if (jobs.has(id)) jobs.delete(id); else doneIds.add(id);
    if (kind === 'screen') {
      lastResult = ok ? { path: output } : { path: input, warn: true };
    }
    if (!ok) toast(t('errConvert'), 'error');
    renderStatus();
    refreshLibrary();
  });

  api.onSettingsChanged((s) => { S = s; syncUI(); });

  function renderStatus() {
    const key = { idle: 'statusReady', starting: 'statusStarting', recording: 'statusRec', paused: 'statusPaused', stopping: 'statusStopping' }[rec.state];
    $('#statusMain').textContent = t(key);
    const sub = $('#statusSub');
    sub.replaceChildren();
    const list = Array.from(jobs.values());
    if (list.length) {
      const j = list.find((x) => x.kind === 'screen') || list[0];
      const determinate = j.kind === 'screen' && j.percent >= 0;
      const label = j.kind === 'mic' ? t('convertingMp3') : (determinate ? t('convertingMp4', { p: j.percent }) : t('convertingMp4Wait'));
      sub.append(
        h('span', null, label + (list.length > 1 ? ' ' + t('convertingMore', { n: list.length - 1 }) : '')),
        h('div', { class: 'bar' + (determinate ? '' : ' indet') }, h('i', determinate ? { style: `width:${j.percent}%` } : null))
      );
    } else if (lastResult && rec.state === 'idle') {
      const p = lastResult.path;
      sub.append(
        h('span', { class: lastResult.warn ? 'warn' : 'ok' }, lastResult.warn ? t('errConvert') : (lastResult.raw ? t('doneRaw') : t('done'))),
        h('button', { class: 'ghost sm', type: 'button', onclick: () => api.openPath(p) }, t('play')),
        h('button', { class: 'ghost sm', type: 'button', onclick: () => api.showInFolder(p) }, t('showFolder'))
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Bibliothèque                                                      */
  /* ---------------------------------------------------------------- */
  async function refreshLibrary() {
    try { library = await api.listRecordings(); } catch (_) { library = []; }
    renderLibrary();
  }

  function renderLibrary() {
    const box = $('#libList');
    box.replaceChildren();
    if (!library.length) {
      box.append(h('div', { class: 'empty' }, t('libEmpty')));
      return;
    }
    for (const f of library) {
      const isMic = /_micro\.(webm|mp3)$/i.test(f.name);
      const busy = !!session && (f.path === session.mainFile || f.path === session.micFile);
      const when = new Date(f.mtime).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const meta = [when, fmtBytes(f.size), isMic ? t('tagMic') : null].filter(Boolean).join(', ');
      const acts = [];
      if (!busy) {
        acts.push(h('button', { class: 'ghost sm', type: 'button', onclick: () => api.openPath(f.path) }, t('play')));
        acts.push(h('button', { class: 'ghost sm', type: 'button', onclick: () => api.showInFolder(f.path) }, t('showFolder')));
        if (f.ext === 'webm') {
          acts.push(h('button', {
            class: 'ghost sm', type: 'button',
            onclick: () => startJob({
              input: f.path, kind: isMic ? 'mic' : 'screen', durationMs: 0, h264: false,
              opts: { mode: 'edit', fps: S.fps, quality: S.quality, resolution: S.resolution, keepOriginal: !!S.keepOriginal }
            })
          }, isMic ? t('convertBtnMp3') : t('convertBtn')));
        }
        acts.push(h('button', {
          class: 'ghost sm danger', type: 'button',
          onclick: async () => {
            if (!window.confirm(t('confirmDelete', { n: f.name }))) return;
            const ok = await api.deleteRecording(f.path);
            if (!ok) toast(t('deleteFailed'), 'error');
            refreshLibrary();
          }
        }, t('delete')));
      }
      box.append(
        h('div', { class: 'item' },
          h('span', { class: 'badge ' + f.ext }, f.ext.toUpperCase()),
          h('div', { style: 'min-width:0' }, h('div', { class: 'nm', title: f.name }, f.name), h('div', { class: 'meta' }, meta)),
          h('div', { class: 'acts' }, acts))
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Démarrage                                                         */
  /* ---------------------------------------------------------------- */
  async function init() {
    S = await api.getSettings();
    lang = S.language === 'en' ? 'en' : 'fr';
    buildVu();
    bindSettings();
    applyTheme();
    applyLang();
    await refreshSources();
    if (S.micEnabled) await openMic();
    await refreshDevices();
    if (S.camEnabled) { await primeCamLabels(); await api.camSync(); }
    refreshLibrary();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  }

  init();
})();
