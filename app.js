/* ═══════════════════════════════════════════════════════════
   JogStart — app.js
   Layer: Logic (state machine, sensors, audio, wakelock, history)
   Depends on: DOM elements defined in index.html
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── State machine ────────────────────────────────────────────
const S = { IDLE: 'idle', ARMED: 'armed', JOGGING: 'jogging' };
let state = S.IDLE;

// ── Session state ────────────────────────────────────────────
let steps = 0, cadence = 0, peakCadence = 0;
let startTime = null, elapsedTimer = null;
let cadenceWindow = [], lastAcc = { x: 0, y: 0, z: 0 }, lastPeakTime = 0;
let jogStartTime = 0;   // timestamp when cadence first entered jog range
let bannerShown = false;

// ── User preferences ─────────────────────────────────────────
let sensitivity = 3;
let soundOn = true;
let logN = 0;

// ── System handles ───────────────────────────────────────────
let wlSentinel = null;
let audioCtx = null;
let deferredInstallPrompt = null;

// ── Constants ────────────────────────────────────────────────
const SUSTAIN_MS    = 4000;   // ms of sustained jog cadence before confirming
const PEAK_WINDOW_MS = 2000;  // sliding window for cadence calculation
const STRIDE_M      = 0.78;   // metres per step (average adult ~160spm)
const MET           = 8.0;    // metabolic equivalent for jogging ~8km/h
const WEIGHT_KG     = 70;     // assumed weight; future: make configurable

// ── Environment detection ────────────────────────────────────
// UA-based detection is the only reliable method:
//   - display-mode:standalone is false inside a WebView
//   - window.Android may be undefined during early script execution
//   - UA suffix "JogStartApp/1.0" is set before any JS runs in MainActivity.kt
const IS_APK = navigator.userAgent.includes('JogStartApp/');
const IS_STANDALONE = !IS_APK && (
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true
);

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const permOverlay   = $('permOverlay');
const permBtn       = $('permBtn');
const mainBtn       = $('mainBtn');
const musicBanner   = $('musicBanner');
const msub          = $('msub');
const resetBtn      = $('resetBtn');
const soundBtn      = $('soundBtn');
const helpBtn       = $('helpBtn');
const histBtn       = $('histBtn');
const helpSheet     = $('helpSheet');
const histSheet     = $('histSheet');
const closeHelp     = $('closeHelp');
const closeHist     = $('closeHist');
const clearHist     = $('clearHist');
const cvalEl        = $('cval');
const stxtEl        = $('stxt');
const ringFill      = $('ringFill');
const ringWrap      = $('ringWrap');
const stepCountEl   = $('stepCount');
const elapsedEl     = $('elapsed');
const peakSpmEl     = $('peakSpm');
const distValEl     = $('distVal');
const calValEl      = $('calVal');
const logBd         = $('logBd');
const logCountEl    = $('logCount');
const sensSlider    = $('sensSlider');
const sensValEl     = $('sensVal');
const jogMinEl      = $('jogMin');
const jogMaxEl      = $('jogMax');
const musicQueryEl  = $('musicQuery');
const musicQueryRow = $('musicQueryRow');
const wlDot         = $('wlDot');
const wlLabel       = $('wlLabel');
const histList      = $('histList');
const pwaBadge      = $('pwaBadge');
const installBanner = $('installBanner');
const installClose  = $('installClose');

// ── Helpers ──────────────────────────────────────────────────
const getJogMin = () => parseInt(jogMinEl.value) || 110;
const getJogMax = () => parseInt(jogMaxEl.value) || 210;

// ═══════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════
function log(msg, type = 'info') {
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'le ' + type;
  el.innerHTML = `<span class="ts">${ts}</span><span class="msg">${msg}</span>`;
  logBd.prepend(el);
  logCountEl.textContent = ++logN + ' events';
}

// ═══════════════════════════════════════════════════════════
// AUDIO  (Web Audio API — no network, no popup)
// AudioContext must be created inside a user gesture.
// initAudio() is called lazily on first button tap.
// ═══════════════════════════════════════════════════════════
function initAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { /* silently unavailable */ }
  }
}

function beep(freq = 880, dur = 0.17, vol = 0.35) {
  if (!soundOn || !audioCtx) return;
  try {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, audioCtx.currentTime);
    g.gain.setValueAtTime(vol, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch (e) { /* audio unavailable */ }
}

// Ascending 3-beep fanfare played when jog is confirmed
function playJogFanfare() {
  [0, 180, 360].forEach((ms, i) =>
    setTimeout(() => beep([660, 770, 880][i], 0.15, 0.4), ms)
  );
}

// ═══════════════════════════════════════════════════════════
// SCREEN WAKELOCK
// Key rule: call wakeLock.request() SYNCHRONOUSLY (no await before it).
// Handling with .then()/.catch() lets it resolve in the background
// without consuming the user-gesture token.
// 500ms retry handles the brief focus-loss during tap animation.
// ═══════════════════════════════════════════════════════════
function onWakelockGranted(sentinel) {
  wlSentinel = sentinel;
  wlDot.classList.add('on');
  wlLabel.textContent = 'Screen lock: on';
  sentinel.addEventListener('release', () => {
    wlDot.classList.remove('on');
    wlLabel.textContent = 'Screen lock: off';
    wlSentinel = null;
  });
  log('Screen wakelock ON', 'ok');
}

function acquireWakelock() {
  if (!('wakeLock' in navigator)) { log('Wakelock not supported', 'warn'); return; }
  if (wlSentinel) return;
  navigator.wakeLock.request('screen')
    .then(onWakelockGranted)
    .catch(e => {
      log('Wakelock: retrying in 500ms (' + e.message + ')', 'warn');
      setTimeout(() => {
        if (state === S.IDLE || wlSentinel) return;
        navigator.wakeLock.request('screen')
          .then(onWakelockGranted)
          .catch(e2 => log('Wakelock unavailable: ' + e2.message, 'warn'));
      }, 500);
    });
}

function releaseWakelock() {
  if (wlSentinel) { wlSentinel.release().catch(() => {}); wlSentinel = null; }
}

// ═══════════════════════════════════════════════════════════
// DEVICE MOTION PERMISSION  (iOS 13+ only; Android auto-grants)
// ═══════════════════════════════════════════════════════════
function checkPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    permOverlay.classList.remove('hidden');
  } else {
    permOverlay.classList.add('hidden');
    log('Motion sensor ready', 'ok');
  }
}

permBtn.addEventListener('click', async () => {
  initAudio();
  try {
    const r = await DeviceMotionEvent.requestPermission();
    permOverlay.classList.add('hidden');
    log(r === 'granted' ? 'Permission granted' : 'Permission denied',
        r === 'granted' ? 'ok' : 'err');
    if (r !== 'granted') { permBtn.textContent = 'Denied'; permBtn.disabled = true; }
  } catch {
    permOverlay.classList.add('hidden');
    log('Motion sensor ready', 'ok');
  }
});

// ═══════════════════════════════════════════════════════════
// STEP / CADENCE DETECTION
// Algorithm: threshold the acceleration delta magnitude,
// enforce minimum inter-peak interval, compute cadence from
// a 2-second sliding window of peak timestamps.
// ═══════════════════════════════════════════════════════════
function getThreshold() {
  return [2.5, 2.0, 1.4, 1.0, 0.8][sensitivity - 1];
}

function onMotion(e) {
  if (state !== S.ARMED && state !== S.JOGGING) return;
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if (!acc || acc.x == null || acc.y == null || acc.z == null) return;

  const dx = acc.x - lastAcc.x, dy = acc.y - lastAcc.y, dz = acc.z - lastAcc.z;
  lastAcc = { x: acc.x, y: acc.y, z: acc.z };
  const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const now = Date.now();

  if (mag > getThreshold() && now - lastPeakTime > 250) {
    lastPeakTime = now;
    stepCountEl.textContent = ++steps;
    distValEl.textContent = (steps * STRIDE_M / 1000).toFixed(2);

    ringWrap.classList.add('flash');
    setTimeout(() => ringWrap.classList.remove('flash'), 180);

    cadenceWindow.push(now);
    cadenceWindow = cadenceWindow.filter(t => now - t < PEAK_WINDOW_MS);

    if (cadenceWindow.length >= 2) {
      const dur = cadenceWindow.at(-1) - cadenceWindow[0];
      if (dur === 0) return;
      cadence = Math.round((cadenceWindow.length - 1) / dur * 60000);
      updateRing();

      const JOG_MIN = getJogMin(), JOG_MAX = getJogMax();
      if (cadence >= JOG_MIN && cadence <= JOG_MAX) {
        if (jogStartTime === 0) jogStartTime = now;
        if (state === S.ARMED && now - jogStartTime >= SUSTAIN_MS) {
          transitionToJogging();
        }
      } else {
        jogStartTime = 0; // cadence left jog range — reset sustained timer
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// RING UI
// Maps cadence (60–200 spm) to ring fill percentage.
// Colours: green = jog range, yellow = walking, red = sprinting.
// ═══════════════════════════════════════════════════════════
function updateRing() {
  const JOG_MIN = getJogMin(), JOG_MAX = getJogMax();
  cvalEl.textContent = cadence > 0 ? cadence : '--';
  if (cadence > peakCadence && cadence < 300) peakSpmEl.textContent = peakCadence = cadence;

  const pct = Math.min(Math.max((cadence - 60) / 140, 0), 1);
  ringFill.style.strokeDashoffset = 2 * Math.PI * 80 * (1 - pct);

  const col = cadence >= JOG_MIN && cadence <= JOG_MAX ? 'var(--accent)'
            : cadence > 0 && cadence < JOG_MIN           ? 'var(--warn)'
            : 'var(--accent2)';
  ringFill.style.stroke = cvalEl.style.color = col;
}

// ═══════════════════════════════════════════════════════════
// SESSION HISTORY  (localStorage — max 50 sessions)
// ═══════════════════════════════════════════════════════════
function saveSession() {
  const dur = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
  if (dur < 10 || steps < 20) return; // skip trivially short sessions
  const session = {
    date: new Date().toISOString(),
    steps,
    duration: dur,
    peakCadence,
    distance: parseFloat((steps * STRIDE_M / 1000).toFixed(2)),
    calories: Math.round(MET * WEIGHT_KG * (dur / 3600)),
  };
  try {
    const hist = JSON.parse(localStorage.getItem('jogstart_hist') || '[]');
    hist.unshift(session);
    if (hist.length > 50) hist.length = 50;
    localStorage.setItem('jogstart_hist', JSON.stringify(hist));
    log('Session saved to history', 'ok');
  } catch (e) { log('Could not save history', 'warn'); }
}

function renderHistory() {
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem('jogstart_hist') || '[]'); } catch (e) {}
  if (hist.length === 0) {
    histList.innerHTML = '<div class="hist-empty">No sessions yet.<br>Complete a jog to see your history here.</div>';
    return;
  }
  histList.innerHTML = hist.map(s => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const durMin = Math.floor(s.duration / 60), durSec = s.duration % 60;
    return `<div class="hist-item">
      <div class="hist-date">${dateStr} · ${timeStr}</div>
      <div class="hist-grid">
        <div class="sc hist-stat"><div class="sv">${s.steps.toLocaleString()}</div><div class="sl">Steps</div></div>
        <div class="sc hist-stat"><div class="sv">${durMin}:${String(durSec).padStart(2, '0')}</div><div class="sl">Duration</div></div>
        <div class="sc hist-stat"><div class="sv">${s.peakCadence || '--'}</div><div class="sl">Peak SPM</div></div>
        <div class="sc hist-stat"><div class="sv">${s.distance}</div><div class="sl">km</div></div>
        <div class="sc hist-stat"><div class="sv">${s.calories}</div><div class="sl">Cal</div></div>
      </div>
    </div>`;
  }).join('');
}

clearHist.addEventListener('click', () => {
  if (!confirm('Clear all session history?')) return;
  localStorage.removeItem('jogstart_hist');
  renderHistory();
  log('History cleared', 'warn');
});

// ═══════════════════════════════════════════════════════════
// STATE TRANSITIONS
// ═══════════════════════════════════════════════════════════
function resetUI() {
  steps = cadence = peakCadence = jogStartTime = 0;
  bannerShown = false;
  cadenceWindow = []; lastAcc = { x: 0, y: 0, z: 0 }; lastPeakTime = 0;
  stepCountEl.textContent = '0';
  peakSpmEl.textContent = '--';
  elapsedEl.textContent = '0:00';
  distValEl.textContent = '0.00';
  calValEl.textContent = '0';
  cvalEl.textContent = '--';
  cvalEl.style.color = 'var(--accent)';
  ringFill.style.strokeDashoffset = 2 * Math.PI * 80;
  ringFill.style.stroke = 'var(--accent)';
  musicBanner.classList.remove('show');
  musicBanner.style.opacity = '';
  msub.textContent = 'Jogging detected — tap to play!';
}

// ── START / STOP (synchronous — no async/await to preserve gesture token) ──
mainBtn.addEventListener('click', () => {
  initAudio();
  if (state === S.IDLE) {
    acquireWakelock(); // must be called synchronously here
    state = S.ARMED;
    resetUI();
    stxtEl.textContent = 'Waiting for jog…';
    mainBtn.textContent = '■ Stop Session';
    mainBtn.className = 'btn armed';
    startTime = Date.now();
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startTime) / 1000);
      elapsedEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      calValEl.textContent = Math.round(MET * WEIGHT_KG * (s / 3600));
    }, 1000);
    window.addEventListener('devicemotion', onMotion);
    log('Session armed — start running!', 'ok');
  } else {
    saveSession();
    window.removeEventListener('devicemotion', onMotion);
    clearInterval(elapsedTimer);
    ringWrap.classList.remove('jog-active');
    releaseWakelock();
    state = S.IDLE;
    stxtEl.textContent = 'Session ended';
    mainBtn.textContent = '▶ Start Jog Session';
    mainBtn.className = 'btn';
    log('Ended — ' + steps + ' steps in ' + elapsedEl.textContent, 'ok');
  }
});

function transitionToJogging() {
  state = S.JOGGING;
  ringWrap.classList.add('jog-active');
  stxtEl.textContent = 'Jogging!';
  mainBtn.className = 'btn jogging';
  log('Jog confirmed at ' + cadence + ' spm', 'ok');
  playJogFanfare();

  if (!bannerShown) {
    bannerShown = true;
    requestAnimationFrame(() => requestAnimationFrame(() => musicBanner.classList.add('show')));

    if (IS_APK || IS_STANDALONE) {
      setTimeout(() => {
        if (IS_APK) {
          // Poll for window.Android bridge (up to 1s) then fire playback
          let attempts = 0;
          const tryBridge = () => {
            if (window.Android && typeof window.Android.launchYouTubeMusic === 'function') {
              try {
                const query = musicQueryEl ? musicQueryEl.value.trim() : '';
                window.Android.launchYouTubeMusic(query);
                const msg = query
                  ? `▶ Playing "${query}" in YouTube Music`
                  : '▶ YouTube Music auto-play started';
                log(msg, 'ok');
                musicBanner.style.opacity = '0.5';
                msub.textContent = 'Playing now — enjoy your run! 🎶';
              } catch (e) {
                log('Bridge error: ' + e.message, 'warn');
                launchViaIntentUri();
              }
            } else if (++attempts < 10) {
              setTimeout(tryBridge, 100);
            } else {
              log('Bridge timeout — trying intent URI', 'warn');
              launchViaIntentUri();
            }
          };
          tryBridge();
        } else {
          // PWA standalone — intent URI (best-effort without a gesture)
          launchViaIntentUri();
        }
      }, 400); // delay so fanfare beep finishes first
    } else {
      log('Tap the green banner to open YouTube Music', 'warn');
    }
  }
}

// ── RESET ──
resetBtn.addEventListener('click', () => {
  initAudio();
  window.removeEventListener('devicemotion', onMotion);
  clearInterval(elapsedTimer);
  ringWrap.classList.remove('jog-active');
  releaseWakelock();
  state = S.IDLE;
  resetUI();
  stxtEl.textContent = 'Idle';
  mainBtn.textContent = '▶ Start Jog Session';
  mainBtn.className = 'btn';
  log('Reset', 'warn');
});

// ═══════════════════════════════════════════════════════════
// MUSIC LAUNCH HELPERS
// ═══════════════════════════════════════════════════════════

// Intent URI fallback — works from a user tap (gesture present).
// In an APK setTimeout context it may open the web page instead;
// the MediaBrowserCompat approach in MainActivity.kt is the real fix.
function launchViaIntentUri() {
  const fallback = encodeURIComponent('https://music.youtube.com/');
  location.href =
    'intent://music.youtube.com/#Intent;' +
    'scheme=https;' +
    'package=com.google.android.apps.youtube.music;' +
    'S.browser_fallback_url=' + fallback + ';' +
    'end';
  log('▶ Launching via intent URI', 'warn');
  musicBanner.style.opacity = '0.5';
  msub.textContent = 'Launching… enjoy your run! 🎶';
}

// ── Music banner tap ──
musicBanner.addEventListener('click', () => {
  if (IS_APK && window.Android) {
    try {
      const query = musicQueryEl ? musicQueryEl.value.trim() : '';
      window.Android.launchYouTubeMusic(query);
      log('YouTube Music launched via native bridge', 'ok');
    } catch (e) { launchViaIntentUri(); }
  } else {
    launchViaIntentUri();
  }
  musicBanner.style.opacity = '0.5';
  msub.textContent = 'Opened — enjoy your run! 🎶';
});

// ═══════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════
soundBtn.addEventListener('click', () => {
  initAudio();
  soundOn = !soundOn;
  soundBtn.textContent = soundOn ? '🔔 Sound' : '🔕 Muted';
  soundBtn.classList.toggle('active-toggle', soundOn);
  if (soundOn) beep(660, 0.1, 0.3);
  log('Sound ' + (soundOn ? 'on' : 'off'), 'info');
});

sensSlider.addEventListener('input', () => {
  sensitivity = parseInt(sensSlider.value);
  sensValEl.textContent = sensitivity;
  log('Sensitivity: ' + ['Low', 'Med-Low', 'Medium', 'Med-High', 'High'][sensitivity - 1], 'info');
});

jogMinEl.addEventListener('change', () => log('Jog min: ' + getJogMin() + ' spm', 'info'));
jogMaxEl.addEventListener('change', () => log('Jog max: ' + getJogMax() + ' spm', 'info'));

// ── Sheet navigation ──
helpBtn.addEventListener('click', () => helpSheet.classList.add('open'));
closeHelp.addEventListener('click', () => helpSheet.classList.remove('open'));
histBtn.addEventListener('click', () => { renderHistory(); histSheet.classList.add('open'); });
closeHist.addEventListener('click', () => histSheet.classList.remove('open'));

// Swipe-down to close sheets
[helpSheet, histSheet].forEach(sheet => {
  let ty = 0;
  sheet.addEventListener('touchstart', e => { ty = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - ty > 60) sheet.classList.remove('open');
  }, { passive: true });
});

// Re-acquire wakelock when page becomes visible after app-switch
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state !== S.IDLE && !wlSentinel) {
    navigator.wakeLock?.request('screen').then(onWakelockGranted).catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════
// PWA INSTALL BANNER
// ═══════════════════════════════════════════════════════════
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

installBanner.addEventListener('click', async e => {
  if (e.target === installClose) { installBanner.classList.add('hidden'); return; }
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') log('PWA installed — relaunch for auto-play', 'ok');
    deferredInstallPrompt = null;
    installBanner.classList.add('hidden');
  } else {
    log('Tap browser menu → Add to Home Screen', 'warn');
    installBanner.querySelector('.install-banner-sub').textContent =
      'Tap ⋮ menu → "Add to Home Screen", then relaunch from home screen';
  }
});

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
checkPermission();

if (IS_APK) {
  pwaBadge.classList.add('show');
  pwaBadge.querySelector('span').textContent = 'Native app — auto-play enabled';
  installBanner.classList.add('hidden');
  if (musicQueryRow) musicQueryRow.style.display = 'block';
  initAudio();
  log('JogStart APK mode — native bridge active', 'ok');
} else if (IS_STANDALONE) {
  pwaBadge.classList.add('show');
  installBanner.classList.add('hidden');
  if (musicQueryRow) musicQueryRow.style.display = 'none';
  initAudio();
  log('PWA standalone mode — intent URI active', 'ok');
} else {
  if (musicQueryRow) musicQueryRow.style.display = 'none';
  if (!localStorage.getItem('installDismissed')) {
    installBanner.classList.remove('hidden');
  }
  installClose.addEventListener('click', () => {
    installBanner.classList.add('hidden');
    localStorage.setItem('installDismissed', '1');
  });
}

log('JogStart v4 ready' + (IS_APK ? ' [APK]' : IS_STANDALONE ? ' [PWA]' : ''), 'ok');
