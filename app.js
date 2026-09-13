/* SayMyName — record locally, publish deliberately.
   Nothing in this file uploads anything. The recording lives in memory and in
   IndexedDB on this device only; Discard clears both. */

const MAX_MS = 15000;          // hard cap on a take
const BUCKET_MS = 100;         // one waveform bar per 100ms
const MAX_BARS = MAX_MS / BUCKET_MS;

const $ = (id) => document.getElementById(id);

const el = {
  card: $('card'), cardPlay: $('cardPlay'), cardName: $('cardName'),
  cardPhonetic: $('cardPhonetic'), cardSlug: $('cardSlug'),
  wave: $('wave'), recBtn: $('recBtn'), recLabel: $('recLabel'), timer: $('timer'),
  takes: $('takes'), playBtn: $('playBtn'), playLabel: $('playLabel'), discardBtn: $('discardBtn'),
  nameInput: $('nameInput'), phoneticInput: $('phoneticInput'), slugInput: $('slugInput'),
  publishBtn: $('publishBtn'),
  scrim: $('scrim'), modalX: $('modalX'), modalBack: $('modalBack'), modalSlug: $('modalSlug'),
  toast: $('toast'),
};

const state = {
  blob: null,
  objectUrl: null,
  peaks: [],          // 0..1 amplitude per bucket
  durationMs: 0,
  recording: false,
  slugTouched: false,
};

const audio = new Audio();
audio.preload = 'auto';

/* ── IndexedDB: survive a refresh or an OAuth redirect ───────────────── */

const DB = { name: 'saymyname', store: 'take', key: 'current' };

function withStore(mode) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB.name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB.store);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(DB.store, mode);
      tx.oncomplete = () => db.close();
      resolve(tx.objectStore(DB.store));
    };
  });
}

async function saveTake() {
  if (!state.blob) return;
  try {
    const store = await withStore('readwrite');
    store.put({
      blob: state.blob,
      peaks: state.peaks,
      durationMs: state.durationMs,
      name: el.nameInput.value,
      phonetic: el.phoneticInput.value,
      slug: el.slugInput.value,
      slugTouched: state.slugTouched,
    }, DB.key);
  } catch { /* private mode, blocked storage — the in-memory take still works */ }
}

async function loadTake() {
  try {
    const store = await withStore('readonly');
    const rec = await new Promise((res, rej) => {
      const r = store.get(DB.key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    if (!rec || !rec.blob) return;
    state.blob = rec.blob;
    state.peaks = rec.peaks || [];
    state.durationMs = rec.durationMs || 0;
    state.slugTouched = !!rec.slugTouched;
    el.nameInput.value = rec.name || '';
    el.phoneticInput.value = rec.phonetic || '';
    el.slugInput.value = rec.slug || '';
    attachBlob();
    render();
    toast('Picked up where you left off.');
  } catch { /* nothing stored, or storage unavailable */ }
}

async function clearTake() {
  try {
    const store = await withStore('readwrite');
    store.delete(DB.key);
  } catch { /* nothing to clear */ }
}

/* ── waveform ────────────────────────────────────────────────────────── */

const ctx2d = el.wave.getContext('2d');
let playHead = 0;   // 0..1

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = el.wave.clientWidth;
  const h = el.wave.clientHeight;
  el.wave.width = Math.round(w * dpr);
  el.wave.height = Math.round(h * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWave();
}

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function drawWave() {
  const w = el.wave.clientWidth;
  const h = el.wave.clientHeight;
  ctx2d.clearRect(0, 0, w, h);

  const mid = h / 2;
  const pad = 14;
  const usable = w - pad * 2;
  const slot = usable / MAX_BARS;
  const barW = Math.max(1.5, slot * 0.6);

  const idle = cssVar('--line');
  const grey = cssVar('--ink-2');
  const green = cssVar('--green');
  const red = cssVar('--red');

  // baseline for the yet-unrecorded span
  ctx2d.fillStyle = idle;
  for (let i = state.peaks.length; i < MAX_BARS; i++) {
    const x = pad + i * slot;
    ctx2d.fillRect(x, mid - 1, barW, 2);
  }

  const playedUpTo = state.peaks.length * playHead;
  for (let i = 0; i < state.peaks.length; i++) {
    const amp = Math.min(1, state.peaks[i]);
    const barH = Math.max(2, amp * (h - 26));
    const x = pad + i * slot;
    ctx2d.fillStyle = state.recording ? red : (i < playedUpTo ? green : grey);
    ctx2d.globalAlpha = state.recording ? 1 : (i < playedUpTo ? 1 : 0.55);
    ctx2d.fillRect(x, mid - barH / 2, barW, barH);
  }
  ctx2d.globalAlpha = 1;
}

/* ── recording ───────────────────────────────────────────────────────── */

let recorder = null, stream = null, audioCtx = null, analyser = null;
let rafId = null, startedAt = 0, bucketStart = 0, bucketPeak = 0;

function pickMimeType() {
  const candidates = [
    'audio/mp4',                    // Safari
    'audio/webm;codecs=opus',       // Chrome, Edge, Firefox
    'audio/webm',
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser can’t record audio.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    toast(err && err.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow it in the address bar and try again.'
      : 'No microphone available.');
    return;
  }

  stopPlayback();
  state.peaks = [];
  playHead = 0;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(stream).connect(analyser);

  const mimeType = pickMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => finishRecording(chunks, recorder.mimeType || mimeType);
  recorder.start();

  state.recording = true;
  startedAt = performance.now();
  bucketStart = startedAt;
  bucketPeak = 0;
  el.recBtn.classList.add('recording');
  el.recLabel.textContent = 'Stop';
  el.publishBtn.disabled = true;
  el.cardPlay.disabled = true;
  tick();
}

function tick() {
  const now = performance.now();
  const elapsed = now - startedAt;

  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  bucketPeak = Math.max(bucketPeak, Math.min(1, rms * 3.2));

  if (now - bucketStart >= BUCKET_MS) {
    state.peaks.push(bucketPeak);
    bucketPeak = 0;
    bucketStart = now;
  }

  el.timer.innerHTML = `${fmt(elapsed)} <span class="timer-max">/ 0:15</span>`;
  drawWave();

  if (elapsed >= MAX_MS) { stopRecording(); return; }
  rafId = requestAnimationFrame(tick);
}

function stopRecording() {
  if (!state.recording) return;
  cancelAnimationFrame(rafId);
  state.durationMs = Math.min(MAX_MS, performance.now() - startedAt);
  state.recording = false;
  try { recorder.stop(); } catch { /* already stopped */ }
  stream.getTracks().forEach((t) => t.stop());
  audioCtx.close();
  el.recBtn.classList.remove('recording');
  el.recLabel.textContent = 'Re-record';
}

function finishRecording(chunks, mimeType) {
  state.blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
  attachBlob();
  saveTake();
  render();
  drawWave();
}

function attachBlob() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(state.blob);
  audio.src = state.objectUrl;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ── playback ────────────────────────────────────────────────────────── */

let playRaf = null;

function togglePlayback() {
  if (!state.blob) return;
  if (!audio.paused) { stopPlayback(); return; }
  audio.currentTime = 0;
  audio.play().then(() => {
    el.playLabel.textContent = 'Stop';
    el.cardPlay.classList.add('playing');
    trackPlayhead();
  }).catch(() => toast('Couldn’t play that take.'));
}

function trackPlayhead() {
  const dur = state.durationMs / 1000;
  playHead = dur > 0 ? Math.min(1, audio.currentTime / dur) : 0;
  drawWave();
  if (!audio.paused) playRaf = requestAnimationFrame(trackPlayhead);
}

function stopPlayback() {
  cancelAnimationFrame(playRaf);
  audio.pause();
  playHead = 0;
  el.playLabel.textContent = 'Play';
  el.cardPlay.classList.remove('playing');
  drawWave();
}

audio.addEventListener('ended', stopPlayback);

/* ── discard ─────────────────────────────────────────────────────────── */

async function discard() {
  stopPlayback();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.blob = null;
  state.objectUrl = null;
  state.peaks = [];
  state.durationMs = 0;
  audio.removeAttribute('src');
  audio.load();
  await clearTake();
  el.recLabel.textContent = 'Record';
  el.timer.innerHTML = '0:00 <span class="timer-max">/ 0:15</span>';
  render();
  drawWave();
  toast('Deleted. Nothing was ever uploaded.');
}

/* ── the card, kept in sync ──────────────────────────────────────────── */

function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function render() {
  const name = el.nameInput.value.trim();
  const phonetic = el.phoneticInput.value.trim();
  const slug = el.slugInput.value.trim() || 'yourname';

  el.cardName.textContent = name || 'Your name';
  el.cardName.classList.toggle('empty', !name);
  el.cardPhonetic.textContent = phonetic || 'pro·nun·ci·a·tion';
  el.cardPhonetic.classList.toggle('empty', !phonetic);
  el.cardSlug.textContent = slug;
  el.modalSlug.textContent = `saymyname.app/${slug}`;

  const ready = !!state.blob && !!name && !!el.slugInput.value.trim();
  el.publishBtn.disabled = !ready || state.recording;
  el.cardPlay.disabled = !state.blob;
  el.takes.hidden = !state.blob;
}

let saveTimer = null;
function onFieldChange() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveTake, 400);
}

/* ── modal ───────────────────────────────────────────────────────────── */

function openModal() {
  el.scrim.hidden = false;
  el.modalX.focus();
}
function closeModal() {
  el.scrim.hidden = true;
  el.publishBtn.focus();
}

/* ── toast ───────────────────────────────────────────────────────────── */

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 200);
  }, 2600);
}

/* ── wiring ──────────────────────────────────────────────────────────── */

el.recBtn.addEventListener('click', () => state.recording ? stopRecording() : startRecording());
el.playBtn.addEventListener('click', togglePlayback);
el.cardPlay.addEventListener('click', togglePlayback);
el.discardBtn.addEventListener('click', discard);
el.publishBtn.addEventListener('click', openModal);

el.nameInput.addEventListener('input', () => {
  if (!state.slugTouched) el.slugInput.value = slugify(el.nameInput.value);
  onFieldChange();
});
el.phoneticInput.addEventListener('input', onFieldChange);
el.slugInput.addEventListener('input', () => {
  state.slugTouched = el.slugInput.value.length > 0;
  el.slugInput.value = el.slugInput.value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  onFieldChange();
});

el.modalX.addEventListener('click', closeModal);
el.modalBack.addEventListener('click', closeModal);
el.scrim.addEventListener('click', (e) => { if (e.target === el.scrim) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.scrim.hidden) closeModal();
});
document.querySelectorAll('.provider').forEach((b) => {
  b.addEventListener('click', () => {
    // Stub. Before any redirect-based sign-in lands here, the take is already
    // in IndexedDB, so bouncing out to a provider and back keeps the recording.
    saveTake();
    toast(`${b.dataset.provider} sign-in isn’t wired up yet.`);
  });
});

window.addEventListener('beforeunload', (e) => {
  if (state.blob || state.recording) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('resize', sizeCanvas);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWave);

sizeCanvas();
render();
loadTake();
