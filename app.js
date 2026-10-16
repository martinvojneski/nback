'use strict';

(() => {
  // ---------- Constants ----------
  const LETTERS = ['C', 'H', 'K', 'L', 'Q', 'R', 'S', 'T'];
  const TONES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
  const CELLS = [0, 1, 2, 3, 5, 6, 7, 8]; // 3x3 grid, centre (4) is the fixation point
  const STIM_MS = 500;
  const BASE_TRIALS = 20; // a session is 20 + N turns
  const MATCH_RATE = 0.3; // share of scorable turns that are matches, per modality
  const N_MIN = 1;
  const N_MAX = 12;
  const UP_AT = 80;
  const DOWN_BELOW = 50;
  const MODE_NAMES = { position: 'Position', audio: 'Sound', dual: 'Dual' };
  const MOD_NAMES = { pos: 'Position', aud: 'Sound' };

  const DEFAULTS = { n: 2, mode: 'dual', interval: 3000, sound: 'voice', feedback: true, autoLevel: true };

  // ---------- Storage ----------
  const load = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  };
  const save = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  };

  const settings = Object.assign({}, DEFAULTS, load('nback.settings', {}));
  settings.n = Math.min(N_MAX, Math.max(N_MIN, parseInt(settings.n, 10) || DEFAULTS.n));
  if (!MODE_NAMES[settings.mode]) settings.mode = DEFAULTS.mode;
  if (![2000, 2500, 3000, 3500].includes(settings.interval)) settings.interval = DEFAULTS.interval;
  if (!['voice', 'tones'].includes(settings.sound)) settings.sound = DEFAULTS.sound;
  settings.feedback = settings.feedback !== false;
  settings.autoLevel = settings.autoLevel !== false;
  const persist = () => save('nback.settings', settings);

  let history = load('nback.history', []);
  if (!Array.isArray(history)) history = [];

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const cells = $$('#board .cell');
  const center = $('#center');
  const btnPos = $('#btnPos');
  const btnAud = $('#btnAud');
  const btnFor = { pos: btnPos, aud: btnAud };

  function show(id) {
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === id));
    document.body.dataset.screen = id;
    window.scrollTo(0, 0);
  }

  // ---------- Audio ----------
  const audio = {
    ctx: null,
    voice: null,

    // Must run inside a tap handler: iOS only allows sound that starts from a user gesture.
    unlock() {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
      if (settings.sound === 'tones') {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this.ctx) this.ctx = new AC();
        if (this.ctx.state !== 'running') this.ctx.resume();
        const src = this.ctx.createBufferSource();
        src.buffer = this.ctx.createBuffer(1, 1, 22050);
        src.connect(this.ctx.destination);
        src.start(0);
      } else if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    },

    pickVoice() {
      if (!('speechSynthesis' in window)) return;
      const en = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
      const us = en.filter((v) => /^en[-_]US/i.test(v.lang));
      const preferred = ['Samantha', 'Ava', 'Allison', 'Alex', 'Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'Google US English'];
      this.voice =
        preferred.map((name) => us.find((v) => v.name.includes(name))).find(Boolean) ||
        us.find((v) => v.localService) || us[0] || en[0] || null;
    },

    play(index) {
      if (settings.sound === 'tones') this.tone(TONES[index]);
      else this.say(LETTERS[index]);
    },

    say(letter) {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(letter);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice ? this.voice.lang : 'en-US';
      u.rate = 1.05;
      u.volume = 1;
      speechSynthesis.speak(u);
    },

    tone(freq) {
      const ctx = this.ctx;
      if (!ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    },

    stop() {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    },
  };

  if ('speechSynthesis' in window) {
    audio.pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', () => audio.pickVoice());
  }

  // ---------- Screen wake lock (keeps the phone from dimming mid-session) ----------
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
      wakeLock = null;
    }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* already released */ }
    wakeLock = null;
  }

  // ---------- Sequence ----------
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // A stream of stimulus indices with exactly `matches` n-back matches.
  function makeStream(length, n, size, matches) {
    const eligible = [];
    for (let i = n; i < length; i++) eligible.push(i);
    const matchAt = new Set(shuffle(eligible).slice(0, matches));
    const out = [];
    for (let i = 0; i < length; i++) {
      if (matchAt.has(i)) {
        out.push(out[i - n]);
        continue;
      }
      let v;
      do { v = Math.floor(Math.random() * size); } while (i >= n && v === out[i - n]);
      out.push(v);
    }
    return out;
  }

  // ---------- Game ----------
  let game = null;

  const later = (fn, ms) => { game.timers.push(setTimeout(fn, ms)); };
  const clearTimers = () => {
    if (!game) return;
    game.timers.forEach(clearTimeout);
    game.timers = [];
  };
  const isMatch = (m, i) => i >= game.n && game.seq[m][i] === game.seq[m][i - game.n];
  const pct = (r) => {
    const d = r.hit + r.miss + r.fa;
    return d ? Math.round((100 * r.hit) / d) : 100;
  };

  function startGame() {
    audio.unlock();
    const mode = settings.mode;
    const mods = mode === 'dual' ? ['pos', 'aud'] : mode === 'position' ? ['pos'] : ['aud'];
    const n = settings.n;
    const trials = BASE_TRIALS + n;
    const matches = Math.round(BASE_TRIALS * MATCH_RATE);

    game = {
      n, mode, mods, trials,
      interval: settings.interval,
      i: 0,
      seq: {},
      res: {},
      resp: { pos: false, aud: false },
      timers: [],
      paused: false,
      running: false,
    };
    for (const m of mods) {
      game.seq[m] = makeStream(trials, n, 8, matches);
      game.res[m] = { hit: 0, miss: 0, fa: 0, cr: 0 };
    }

    $('#game').classList.toggle('single', mods.length === 1);
    btnPos.hidden = !mods.includes('pos');
    btnAud.hidden = !mods.includes('aud');
    $('#gLabel').textContent = `${MODE_NAMES[mode]} · ${n}-back`;
    $('#pauseOverlay').hidden = true;
    clearBoard();
    resetButtons();
    updateCounter();
    show('game');
    requestWakeLock();
    countdown(runTrial);
  }

  function countdown(done) {
    let k = 3;
    game.running = false;
    const tick = () => {
      if (!game || game.paused) return;
      center.classList.remove('pop');
      if (k === 0) {
        center.textContent = '';
        center.classList.remove('count');
        done();
        return;
      }
      center.textContent = k;
      center.classList.add('count');
      void center.offsetWidth; // restart the animation
      center.classList.add('pop');
      k--;
      later(tick, 650);
    };
    tick();
  }

  function runTrial() {
    if (!game || game.paused) return;
    if (game.i >= game.trials) {
      finishGame();
      return;
    }
    const i = game.i;
    game.running = true;
    game.resp = { pos: false, aud: false };
    resetButtons();
    updateCounter();

    if (game.seq.pos) lightCell(CELLS[game.seq.pos[i]]);
    if (game.seq.aud) {
      audio.play(game.seq.aud[i]);
      if (!game.seq.pos) beat();
    }

    later(clearBoard, STIM_MS);
    later(() => {
      scoreTrial(i);
      game.i++;
      runTrial();
    }, game.interval);
  }

  function scoreTrial(i) {
    for (const m of game.mods) {
      const r = game.res[m];
      const pressed = game.resp[m];
      if (isMatch(m, i)) {
        if (pressed) r.hit++;
        else {
          r.miss++;
          if (settings.feedback) flash(btnFor[m], 'miss');
        }
      } else if (pressed) r.fa++;
      else r.cr++;
    }
  }

  function respond(m) {
    if (!game || game.paused || !game.running || !game.mods.includes(m) || game.resp[m]) return;
    game.resp[m] = true;
    const btn = btnFor[m];
    btn.classList.remove('good', 'bad', 'pressed', 'miss');
    if (settings.feedback) btn.classList.add(isMatch(m, game.i) ? 'good' : 'bad');
    else btn.classList.add('pressed');
  }

  function pauseGame() {
    if (!game || game.paused) return;
    game.paused = true;
    game.running = false;
    clearTimers();
    clearBoard();
    resetButtons();
    audio.stop();
    center.textContent = '';
    center.classList.remove('count', 'pop');
    releaseWakeLock();
    $('#pauseInfo').textContent = `Turn ${game.i + 1} of ${game.trials} will replay when you resume.`;
    $('#pauseOverlay').hidden = false;
  }

  function resumeGame() {
    if (!game || !game.paused) return;
    game.paused = false;
    $('#pauseOverlay').hidden = true;
    audio.unlock();
    requestWakeLock();
    countdown(runTrial); // replays the interrupted turn
  }

  function quitGame() {
    clearTimers();
    audio.stop();
    releaseWakeLock();
    game = null;
    $('#pauseOverlay').hidden = true;
    renderHome();
    show('home');
  }

  function finishGame() {
    clearTimers();
    releaseWakeLock();
    const g = game;
    game = null;

    const total = { hit: 0, miss: 0, fa: 0 };
    for (const m of g.mods) {
      total.hit += g.res[m].hit;
      total.miss += g.res[m].miss;
      total.fa += g.res[m].fa;
    }
    const score = pct(total);

    let change = 0;
    if (settings.autoLevel) {
      if (score >= UP_AT && g.n < N_MAX) change = 1;
      else if (score < DOWN_BELOW && g.n > N_MIN) change = -1;
      settings.n = g.n + change;
      persist();
    }

    history.push({ t: Date.now(), mode: g.mode, n: g.n, score, res: g.res });
    if (history.length > 1000) history = history.slice(-1000);
    save('nback.history', history);

    renderResults(g, score, change);
    show('results');
  }

  // ---------- Game UI helpers ----------
  function lightCell(index) {
    cells.forEach((c, i) => c.classList.toggle('lit', i === index));
  }
  function clearBoard() {
    cells.forEach((c) => c.classList.remove('lit'));
  }
  function beat() {
    center.classList.remove('beat');
    void center.offsetWidth;
    center.classList.add('beat');
  }
  function resetButtons() {
    for (const b of [btnPos, btnAud]) b.classList.remove('good', 'bad', 'pressed');
  }
  function flash(btn, cls) {
    btn.classList.remove(cls);
    void btn.offsetWidth;
    btn.classList.add(cls);
    setTimeout(() => btn.classList.remove(cls), 750);
  }
  function updateCounter() {
    $('#gCounter').textContent = `${Math.min(game.i + 1, game.trials)} / ${game.trials}`;
    $('#gProgress').style.width = `${(100 * game.i) / game.trials}%`;
  }

  // ---------- Results ----------
  const band = (score) => (score >= UP_AT ? 'up' : score < DOWN_BELOW ? 'down' : 'hold');

  function renderResults(g, score, change) {
    $('#rLabel').textContent = `${MODE_NAMES[g.mode]} · ${g.n}-back`;
    $('#rScore').textContent = score;

    const ring = $('#rRing');
    const C = 2 * Math.PI * 52;
    ring.classList.remove('up', 'hold', 'down');
    ring.classList.add(band(score));
    ring.style.strokeDashoffset = C;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ring.style.strokeDashoffset = C * (1 - score / 100);
    }));

    let verdict;
    if (change > 0) verdict = `Level up! Next: ${settings.n}-back`;
    else if (change < 0) verdict = `Dropping to ${settings.n}-back. Keep at it.`;
    else if (score >= UP_AT) verdict = settings.autoLevel ? 'Top level. Impressive.' : `Great score. Try ${g.n + 1}-back?`;
    else if (settings.autoLevel) verdict = `Staying at ${g.n}-back. Reach ${UP_AT}% to level up.`;
    else verdict = score >= DOWN_BELOW ? 'Nice work.' : 'Tough one. Try a lower level?';
    $('#rVerdict').textContent = verdict;

    $('#rBreakdown').innerHTML = g.mods.map((m) => {
      const r = g.res[m];
      return `
        <div class="mod">
          <div class="mod-head"><span>${MOD_NAMES[m]}</span><b>${pct(r)}%</b></div>
          <div class="mod-stats">
            <div class="g"><b>${r.hit}</b><small>Hits</small></div>
            <div class="m"><b>${r.miss}</b><small>Missed</small></div>
            <div class="f"><b>${r.fa}</b><small>Wrong taps</small></div>
          </div>
        </div>`;
    }).join('');

    $('#againBtn').textContent = `Play ${settings.n}-back`;
  }

  // ---------- Home ----------
  function hintText() {
    const n = settings.n;
    const back = n === 1 ? 'the previous turn' : `${n} turns back`;
    if (settings.mode === 'position') return `Tap Position when the square matches ${back}.`;
    if (settings.mode === 'audio') return `Tap Sound when the ${settings.sound === 'tones' ? 'tone' : 'letter'} matches ${back}.`;
    return `Track squares and ${settings.sound === 'tones' ? 'tones' : 'letters'} from ${back}.`;
  }

  function renderHome() {
    $('#nValue').textContent = settings.n;
    $('#nDown').disabled = settings.n <= N_MIN;
    $('#nUp').disabled = settings.n >= N_MAX;
    $$('.seg').forEach((seg) => {
      const key = seg.dataset.setting;
      seg.querySelectorAll('button').forEach((b) => {
        const on = String(settings[key]) === b.dataset.value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
    });
    $('#optFeedback').checked = settings.feedback;
    $('#optAuto').checked = settings.autoLevel;
    $('#modeHint').textContent = hintText();
    renderStats();
  }

  function fmtWhen(t) {
    const d = new Date(t);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  }

  function renderStats() {
    const today = new Date().toDateString();
    const passed = history.filter((h) => h.mode === settings.mode && h.score >= UP_AT);
    const best = passed.length ? Math.max(...passed.map((h) => h.n)) : 0;

    $('#statToday').textContent = history.filter((h) => new Date(h.t).toDateString() === today).length;
    $('#statTotal').textContent = history.length;
    $('#statBest').textContent = best ? `${best}-back` : '–';
    $('#statBestLabel').textContent = `Best ${MODE_NAMES[settings.mode]}`;
    $('#historyCount').textContent = `${history.length} session${history.length === 1 ? '' : 's'} saved on this device`;

    $('#progressEmpty').hidden = history.length > 0;
    $('#progressBody').hidden = history.length === 0;
    if (!history.length) return;

    // Bar chart: one bar per session (last 30), height = level, colour = score band.
    const data = history.slice(-30);
    const W = 300, H = 96, top = 12, slots = 30, gap = 2;
    const maxN = Math.max(3, ...data.map((d) => d.n));
    const bw = (W - gap * (slots - 1)) / slots;
    const y = (n) => H - (n / maxN) * (H - top);
    let svg = `<line class="grid" x1="0" x2="${W}" y1="${y(maxN)}" y2="${y(maxN)}"/>`;
    svg += `<text x="0" y="${y(maxN) - 4}">${maxN}-back</text>`;
    data.forEach((d, i) => {
      const h = Math.max(3, H - y(d.n));
      svg += `<rect class="${band(d.score)}" x="${(i * (bw + gap)).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="1.5"><title>${MODE_NAMES[d.mode]} ${d.n}-back: ${d.score}%</title></rect>`;
    });
    $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Level of your last ${data.length} sessions">${svg}</svg>`;

    $('#recent').innerHTML = history.slice(-5).reverse().map((h) => `
      <li>
        <span><b>${MODE_NAMES[h.mode]} · ${h.n}-back</b><small>${fmtWhen(h.t)}</small></span>
        <span class="score ${band(h.score)}">${h.score}%</span>
      </li>`).join('');
  }

  // ---------- Events ----------
  $('#startBtn').addEventListener('click', startGame);
  $('#againBtn').addEventListener('click', startGame);
  $('#homeBtn').addEventListener('click', () => { renderHome(); show('home'); });
  $('#pauseBtn').addEventListener('click', pauseGame);
  $('#resumeBtn').addEventListener('click', resumeGame);
  $('#quitBtn').addEventListener('click', quitGame);

  $('#nDown').addEventListener('click', () => {
    settings.n = Math.max(N_MIN, settings.n - 1);
    persist();
    renderHome();
  });
  $('#nUp').addEventListener('click', () => {
    settings.n = Math.min(N_MAX, settings.n + 1);
    persist();
    renderHome();
  });

  $$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = seg.dataset.setting;
    settings[key] = key === 'interval' ? Number(b.dataset.value) : b.dataset.value;
    persist();
    renderHome();
  }));

  $('#optFeedback').addEventListener('change', (e) => { settings.feedback = e.target.checked; persist(); });
  $('#optAuto').addEventListener('change', (e) => { settings.autoLevel = e.target.checked; persist(); });

  $('#clearBtn').addEventListener('click', () => {
    if (!history.length) return;
    if (!confirm('Delete all saved sessions on this device?')) return;
    history = [];
    save('nback.history', history);
    renderStats();
  });

  // Answer buttons fire on touch-down for the fastest possible response.
  for (const btn of [btnPos, btnAud]) {
    const m = btn.dataset.m;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      respond(m);
    });
    btn.addEventListener('click', (e) => { if (e.detail === 0) respond(m); }); // keyboard / assistive tech
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const screen = document.body.dataset.screen;
    if (screen === 'game') {
      if (key === 'a') { e.preventDefault(); respond('pos'); }
      else if (key === 'l') { e.preventDefault(); respond('aud'); }
      else if (key === 'escape' || key === 'p') { e.preventDefault(); if (game && game.paused) resumeGame(); else pauseGame(); }
      else if ((key === ' ' || key === 'enter') && game && game.paused && document.activeElement === document.body) { e.preventDefault(); resumeGame(); }
    } else if ((key === ' ' || key === 'enter') && document.activeElement === document.body) {
      e.preventDefault();
      startGame();
    }
  });

  // Leaving the app (lock screen, app switcher, other tab) pauses the session.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseGame();
  });
  window.addEventListener('pagehide', pauseGame);

  // ---------- Offline support ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  renderHome();
})();
