'use strict';
/* =========================================================================
   Spilletid – lagstyring for barnefotball
   Ingen backend, ingen database. Alt lagres i localStorage.
   ========================================================================= */

/* Versjonen vises nederst på Statistikk-fanen, så du ser hva du faktisk
   kjører etter en oppdatering. Bump denne OG CACHE i sw.js sammen.      */
const APP_VERSION = '1.1.0';

/* Nøkkelen beholdes fra da appen het fotball-manager. Bytter vi den,
   forsvinner alle lagrede data for de som allerede bruker appen.        */
const KEY = 'fm.v1';
const $  = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => Array.from(e.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec + 0.0001));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
function fmtSign(sec) {
  const r = Math.round(sec);
  if (Math.abs(r) < 30) return '±0:00';
  return (r > 0 ? '+' : '−') + fmt(Math.abs(r));
}
function balClass(sec, thr) {
  if (sec > thr) return 'bal-hot';
  if (sec < -thr) return 'bal-cold';
  return 'bal-ok';
}

/* ============================== STATE ============================== */

/* Ett lag eier sin egen tropp, sine kamper og sine kampinnstillinger.
   Spilletidsbalansen løper per lag – trener du to lag, skal de ikke blandes. */
function blankTeam(name) {
  return {
    id: uid(),
    name: name || 'Laget mitt',
    squad: [],
    settings: { duration: 50, onField: 7, periods: 2, interval: 5, maxSwaps: 2, threshold: 60 },
    matches: [],
    currentId: null
  };
}
function blank() {
  const t = blankTeam();
  return { v: 2, teams: [t], teamId: t.id, tab: 'squad', countdown: false };
}
/* Aktivt lag. Alt annet i appen går gjennom denne. */
function T() {
  let t = S.teams.find(x => x.id === S.teamId);
  if (!t) { t = S.teams[0]; if (t) S.teamId = t.id; }
  return t;
}

/* v1 hadde én tropp rett på rota. Gamle data og gamle backup-filer skal
   fortsatt kunne leses, så de pakkes inn som lagets første lag.          */
/* Fyller inn det som mangler i et lag lest fra lagring eller backup, så
   resten av appen kan stole på at feltene finnes og har riktig type.     */
function normTeam(raw) {
  const t = blankTeam(raw && raw.name);
  if (!raw || typeof raw !== 'object') return t;
  if (typeof raw.id === 'string' && raw.id) t.id = raw.id;
  t.squad = (Array.isArray(raw.squad) ? raw.squad : [])
    .filter(p => p && typeof p === 'object' && p.id)
    .map(p => ({ id: String(p.id), name: String(p.name || 'Ukjent'), number: String(p.number || '') }));
  if (raw.settings && typeof raw.settings === 'object') Object.assign(t.settings, raw.settings);
  t.matches = (Array.isArray(raw.matches) ? raw.matches : [])
    .filter(m => m && typeof m === 'object' && m.id)
    .map(m => {
      const obj = x => (x && typeof x === 'object' && !Array.isArray(x)) ? x : {};
      m.lineup = obj(m.lineup); m.sec = obj(m.sec); m.lock = obj(m.lock); m.tgt = obj(m.tgt);
      m.onField = Array.isArray(m.onField) ? m.onField : [];
      m.log = Array.isArray(m.log) ? m.log : [];
      m.periods = clamp(parseInt(m.periods, 10) || 1, 1, 10);
      m.period = clamp(parseInt(m.period, 10) || 1, 1, m.periods);
      m.durationSec = Math.max(60, Number(m.durationSec) || 60);
      m.onFieldCount = clamp(parseInt(m.onFieldCount, 10) || 7, 1, 11);
      m.interval = clamp(parseInt(m.interval, 10) || 5, 1, 30);
      m.maxSwaps = clamp(parseInt(m.maxSwaps, 10) || 1, 1, 11);
      m.threshold = clamp(Number(m.threshold) || 0, 0, 600);
      m.elapsed = Math.max(0, Number(m.elapsed) || 0);
      m.lastSub = clamp(Number(m.lastSub) || 0, 0, m.elapsed);
      m.overChime = Number(m.overChime) || 0;
      m.lastTick = Number(m.lastTick) || Date.now();
      m.running = !!m.running; m.finished = !!m.finished; m.nudged = !!m.nudged;
      return m;
    });
  t.currentId = t.matches.some(m => m.id === raw.currentId) ? raw.currentId : null;
  return t;
}
function migrate(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.v === 1 && Array.isArray(p.squad)) {
    const t = normTeam({ name: 'Laget mitt', squad: p.squad, matches: p.matches,
                         currentId: p.currentId, settings: p.settings });
    return { v: 2, teams: [t], teamId: t.id, tab: p.tab || 'squad', countdown: !!p.countdown };
  }
  if (p.v === 2 && Array.isArray(p.teams) && p.teams.length) {
    const teams = p.teams.map(normTeam);
    const teamId = teams.some(t => t.id === p.teamId) ? p.teamId : teams[0].id;
    return { v: 2, teams: teams, teamId: teamId, tab: p.tab || 'squad', countdown: !!p.countdown };
  }
  return null;
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const m = migrate(JSON.parse(raw));
      if (m) return m;
      /* Ukjent format. Kan skje hvis appen åpnes med en eldre versjon enn den
         som lagret. Ta vare på dataene før vi starter blankt – ellers blir de
         overskrevet ved neste lagring, og da er de borte for godt.          */
      try { localStorage.setItem(KEY + '-berget', raw); } catch (e) {}
    }
  } catch (e) { console.warn('Kunne ikke lese lagrede data', e); }
  return blank();
}
let S = load();

let saveT = null;
function save(now) {
  if (now) { clearTimeout(saveT); saveT = null; return write(); }
  if (saveT) return;
  saveT = setTimeout(() => { saveT = null; write(); }, 800);
}
function write() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { console.warn('Kunne ikke lagre', e); }
}

const P = id => T().squad.find(p => p.id === id);
const cur = () => { const t = T(); return (t && t.matches.find(m => m.id === t.currentId)) || null; };
const pname = id => { const p = P(id); return p ? p.name : 'Ukjent'; };
const pnum = id => { const p = P(id); return p && p.number ? p.number : '–'; };

/* ============================== TID ============================== */
/* All tidsregning skjer i flush(): differansen siden forrige "tick" legges
   til klokka, til spillerne på banen, og til hver spillers "bør spille"-kvote.
   Derfor blir et bytte alltid gjeldende fra det sekundet du bekrefter det.  */

function periodEnd(m) {
  return m.durationSec * clamp(m.period, 1, m.periods) / m.periods;
}
/* Klokka stopper aldri av seg selv. Dommeren bestemmer når omgangen er over,
   ikke appen, så vi lar den gå og varsler i stedet. Dette er hvor langt forbi
   omgangsskillet vi har kommet.                                            */
function overrun(m) {
  return Math.max(0, m.elapsed - periodEnd(m));
}
/* Pause mellom to omganger: klokka står, skillet er passert, mer står igjen. */
function inBreak(m) {
  return !m.running && !m.finished && m.period < m.periods && m.elapsed >= periodEnd(m);
}
function accrue(m, dt) {
  if (!(dt > 0)) return;
  m.elapsed += dt;
  const L = m.lineup;
  let slots = 0;
  m.onField.forEach(id => {
    m.sec[id] = (m.sec[id] || 0) + dt;
    if (L[id] && L[id].locked) m.lock[id] = (m.lock[id] || 0) + dt;
    else slots++;
  });
  const avail = Object.keys(L).filter(id => L[id].share > 0 && !L[id].locked);
  const W = avail.reduce((a, id) => a + L[id].share, 0);
  if (W > 0 && slots > 0) {
    avail.forEach(id => { m.tgt[id] = (m.tgt[id] || 0) + dt * slots * L[id].share / W; });
  }
}
/* Eksakt invers av accrue(). Gikk klokka videre etter at dommeren blåste,
   må den tida trekkes fra igjen for dem som stod på banen - ellers får de
   betalt for tid det ikke ble spilt.                                       */
function rollback(m, dt) {
  if (!(dt > 0)) return;
  dt = Math.min(dt, m.elapsed);
  m.elapsed -= dt;
  const L = m.lineup;
  let slots = 0;
  m.onField.forEach(id => {
    m.sec[id] = Math.max(0, (m.sec[id] || 0) - dt);
    if (L[id] && L[id].locked) m.lock[id] = Math.max(0, (m.lock[id] || 0) - dt);
    else slots++;
  });
  const avail = Object.keys(L).filter(id => L[id].share > 0 && !L[id].locked);
  const W = avail.reduce((a, id) => a + L[id].share, 0);
  if (W > 0 && slots > 0) {
    avail.forEach(id => {
      m.tgt[id] = Math.max(0, (m.tgt[id] || 0) - dt * slots * L[id].share / W);
    });
  }
  m.lastSub = Math.min(m.lastSub, m.elapsed);
  syncChime(m);
}
/* Etter at klokka eller kamplengden er rettet manuelt: still varslene så de
   svarer til der klokka står nå, ellers kommer neste varsel aldri (eller
   straks, for tid som alt er varslet).                                     */
function syncChime(m) {
  const o = overrun(m);
  m.overChime = o > 0 ? 1 + Math.floor(o / 60) : 0;
}

function flush(now) {
  now = now || Date.now();
  const m = cur();
  if (!m) return;
  if (!m.running) { m.lastTick = now; return; }
  const dt = (now - (m.lastTick || now)) / 1000;
  m.lastTick = now;
  if (!(dt > 0)) return;
  accrue(m, dt);
  /* Ett tydelig signal når omgangen er ute, og ett nytt hvert minutt så
     lenge klokka får gå videre. En stoppet klokke blir ikke lagt merke til. */
  const over = overrun(m);
  if (over > 0) {
    const n = 1 + Math.floor(over / 60);
    if (n > (m.overChime || 0)) { m.overChime = n; if (n === 1) chimeEnd(); else chimeNag(); }
  }
}

/* ======================= FORDELING OG FORSLAG ======================= */

/* Saldo over hele turneringen: spilt rotasjonstid minus «bør spille».
   Positiv = har spilt mer enn sin del. Negativ = skal inn.               */
function balances() {
  const b = {};
  T().squad.forEach(p => { b[p.id] = { sec: 0, lock: 0, tgt: 0, rot: 0, bal: 0 }; });
  T().matches.forEach(m => {
    for (const id in m.sec)  if (b[id]) b[id].sec  += m.sec[id];
    for (const id in m.lock) if (b[id]) b[id].lock += m.lock[id];
    for (const id in m.tgt)  if (b[id]) b[id].tgt  += m.tgt[id];
  });
  for (const id in b) { b[id].rot = b[id].sec - b[id].lock; b[id].bal = b[id].rot - b[id].tgt; }
  return b;
}

function suggest(m, b) {
  const L = m.lineup;
  const bal = id => (b[id] ? b[id].bal : 0);
  const bench = Object.keys(L)
    .filter(id => L[id].share > 0 && !L[id].locked && !m.onField.includes(id))
    .sort((x, y) => bal(x) - bal(y));                     // minst spilt først
  const field = m.onField
    .filter(id => L[id] && L[id].share > 0 && !L[id].locked)
    .sort((x, y) => bal(y) - bal(x));                     // mest spilt først

  const pairs = [];
  const used = new Set();

  // Mangler folk på banen? Fyll opp uten å ta noen av.
  let missing = m.onFieldCount - m.onField.length;
  for (const id of bench) {
    if (missing <= 0) break;
    pairs.push({ out: null, in: id, gap: null });
    used.add(id); missing--;
  }

  const ins = bench.filter(id => !used.has(id));
  // Ikke foreslå bytter helt på tampen – de gir ingen utjevning.
  if (m.durationSec - m.elapsed < 60 || m.finished) return pairs;
  const max = Math.max(1, m.maxSwaps);
  for (let i = 0; i < ins.length && i < field.length && pairs.length < max + used.size; i++) {
    const o = field[i], n = ins[i];
    const gap = bal(o) - bal(n);
    if (gap < m.threshold) break;
    pairs.push({ out: o, in: n, gap });
  }
  return pairs;
}

function nudgeDue(m, pairs) {
  if (!m.running || !pairs.length) return false;
  return (m.elapsed - m.lastSub) >= m.interval * 60;
}

/* ============================== KAMP-OPS ============================== */

function newMatch(cfg) {
  const m = {
    id: uid(),
    name: cfg.name,
    createdAt: Date.now(),
    durationSec: cfg.duration * 60,
    onFieldCount: cfg.onField,
    periods: cfg.periods,
    period: 1,
    interval: cfg.interval,
    maxSwaps: cfg.maxSwaps,
    threshold: cfg.threshold,
    lineup: cfg.lineup,          // { id: {share, locked} }
    onField: cfg.onField0.slice(),
    sec: {}, lock: {}, tgt: {},
    elapsed: 0, running: false, lastTick: Date.now(),
    finished: false, overChime: 0,
    lastSub: 0, nudged: false,
    log: []
  };
  Object.keys(m.lineup).forEach(id => { m.sec[id] = 0; m.lock[id] = 0; m.tgt[id] = 0; });
  return m;
}

function toggleRun() {
  const m = cur(); if (!m || m.finished) return;
  flush();
  if (m.running) { m.running = false; releaseWake(); }
  else { m.running = true; m.lastTick = Date.now(); requestWake(); unlockAudio(); }
  save(); paintAll();
}
function nextPeriod() {
  const m = cur(); if (!m) return;
  flush();
  if (m.period >= m.periods) return;
  m.period++; m.lastSub = m.elapsed; m.nudged = false; m.overChime = 0;
  m.running = true; m.lastTick = Date.now(); requestWake(); unlockAudio();
  save(); paintAll();
}
function doSwap(outId, inId) {
  const m = cur(); if (!m) return;
  flush();
  const bad = () => { sel = null; lastSig = ''; paintAll(); };
  if (outId && inId) {
    const i = m.onField.indexOf(outId);
    if (i < 0 || m.onField.includes(inId)) return bad();
    m.onField[i] = inId;
  } else if (inId) {
    if (m.onField.includes(inId)) return bad();
    m.onField.push(inId);
  } else if (outId) {
    if (!m.onField.includes(outId)) return bad();
    m.onField = m.onField.filter(x => x !== outId);
  } else return;
  m.log.push({ t: Math.round(m.elapsed), out: outId, in: inId });
  m.lastSub = m.elapsed; m.nudged = false;
  sel = null;
  save(); paintAll();
}
function applyPairs(pairs) {
  const m = cur(); if (!m) return;
  flush();
  pairs.forEach(p => {
    let done = false;
    if (p.out && p.in) {
      const i = m.onField.indexOf(p.out);
      if (i >= 0 && !m.onField.includes(p.in)) { m.onField[i] = p.in; done = true; }
    } else if (p.in && !m.onField.includes(p.in)) {
      m.onField.push(p.in); done = true;
    }
    if (done) m.log.push({ t: Math.round(m.elapsed), out: p.out, in: p.in });
  });
  m.lastSub = m.elapsed; m.nudged = false;
  sel = null;
  save(); paintAll();
}
function snooze() {
  const m = cur(); if (!m) return;
  flush(); m.lastSub = m.elapsed; m.nudged = false;
  save(); paintAll();
}
function endMatch() {
  const m = cur(); if (!m) return;
  flush();
  m.running = false; m.finished = true; releaseWake();
  T().currentId = null;
  save(true); go('stats');
}

/* ============================== HJELPERE ============================== */

/* Lyd. AudioContext må åpnes av et brukertrykk, så den vekkes i toggleRun()
   og nextPeriod(). Vibrasjon i tillegg, for telefoner på lydløs.           */
let ac = null;
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ac && AC) ac = new AC();
    if (ac && ac.state === 'suspended') ac.resume();
  } catch (e) {}
}
function tone(freq, at, len, vol) {
  if (!ac || ac.state !== 'running') return;
  try {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    const t = ac.currentTime + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + len + 0.03);
  } catch (e) {}
}
function buzz(pat) { try { if (navigator.vibrate) navigator.vibrate(pat); } catch (e) {} }

/* Byttevarsel: kort og nøytralt. */
function beep() { buzz([120, 60, 120]); tone(880, 0, 0.12, 0.22); }
/* Omgangen er ute: stigende trippel, tydelig forskjellig fra byttevarselet. */
function chimeEnd() {
  buzz([200, 90, 200, 90, 420]);
  [784, 988, 1319].forEach((f, i) => tone(f, i * 0.2, 0.22, 0.3));
}
/* Fortsatt overtid: dobbeltpip hvert minutt til noen tar tak i klokka. */
function chimeNag() {
  buzz([320, 130, 320]);
  tone(1047, 0, 0.13, 0.28); tone(1047, 0.19, 0.13, 0.28);
}
let wake = null;
async function requestWake() {
  try {
    if (!('wakeLock' in navigator) || wake) return;
    const w = await navigator.wakeLock.request('screen');
    /* Slippes automatisk når siden går i bakgrunnen. Nullstill, så neste
       requestWake() faktisk ber om en ny.                                */
    w.addEventListener('release', () => { if (wake === w) wake = null; });
    wake = w;
  } catch (e) {}
}
function releaseWake() { try { if (wake) { wake.release(); wake = null; } } catch (e) {} }

/* ============================== VISNING ============================== */

let sel = null;          // valgt spiller for manuelt bytte
let lastSig = '';
/* Når dataene byttes ut under føttene på visningen (import, bytte av lag,
   sletting), må alt som husker spiller-id-er fra før glemmes.            */
function resetView() { sel = null; setup = null; lastSig = ''; }

function go(tab) {
  S.tab = tab; sel = null; lastSig = ''; save();
  ['match', 'setup', 'squad', 'stats'].forEach(t => { $('#view-' + t).hidden = (t !== tab); });
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'setup') renderSetup();
  if (tab === 'squad') renderSquad();
  if (tab === 'stats') renderStats();
  if (tab === 'match') renderMatch();
  window.scrollTo(0, 0);
}
function paintAll() {
  $$('.teamslot').forEach(el => { el.innerHTML = teamBtnHTML(el.dataset.always); });
  if (S.tab === 'match') renderMatch();
  else if (S.tab === 'stats') renderStats();
  else if (S.tab === 'setup') renderSetup();
  else renderSquad();
}

/* ------------------------------- KAMP ------------------------------- */

function matchSig(m, pairs) {
  if (!m) return 'none';
  return [
    m.id, m.running, m.period, m.finished, m.onFieldCount, m.durationSec,
    inBreak(m), (overrun(m) > 0 ? 'o' : ''),
    m.elapsed >= m.durationSec - 0.5, m.nudged,
    m.onField.join(','), sel,
    Object.keys(m.lineup).map(id => id + (m.lineup[id].share) + (m.lineup[id].locked ? 'L' : '')).join('|'),
    pairs.map(p => (p.out || '-') + '>' + p.in).join('|'),
    S.countdown, T().squad.length
  ].join('#');
}

function renderMatch() {
  const el = $('#view-match');
  const m = cur();
  if (!m) {
    if (lastSig !== 'none') { lastSig = 'none'; el.innerHTML = matchEmptyHTML(); }
    return;
  }
  const b = balances();
  const pairs = suggest(m, b);

  if (nudgeDue(m, pairs) && !m.nudged) { m.nudged = true; beep(); save(); }

  const sig = matchSig(m, pairs);
  if (sig !== lastSig) { lastSig = sig; el.innerHTML = matchHTML(m, b, pairs); }
  paintMatch(m, b, pairs);
}

function matchEmptyHTML() {
  const done = T().matches.filter(x => x.finished).length;
  return '<header class="topbar"><h1>Kamp</h1>' + teamBtnHTML() + '</header>' +
    '<div class="card"><div class="empty">Ingen kamp i gang.' +
    (done ? '<br><small>' + done + ' kamp' + (done > 1 ? 'er' : '') + ' ferdigspilt i denne turneringen.</small>' : '') +
    '</div><button class="btn primary big" data-act="tab" data-tab="setup">Sett opp ny kamp</button></div>';
}

function matchHTML(m, b, pairs) {
  const L = m.lineup;
  const bal = id => (b[id] ? b[id].bal : 0);
  const ftime = m.elapsed >= m.durationSec - 0.5;

  /* ---- klokke ---- */
  const pEnd = periodEnd(m);
  let ctrls;
  if (m.finished) ctrls = '';
  else if (m.running) {
    ctrls = '<button class="btn' + (overrun(m) > 0 ? ' warn' : '') + '" data-act="run">⏸ Pause</button>';
  } else if (inBreak(m)) {
    ctrls = '<button class="btn primary" data-act="next-period">Start ' + (m.period + 1) + '. omgang</button>' +
            '<button class="btn ghost" data-act="run">▶ Spill videre</button>';
  } else if (ftime) {
    ctrls = '<button class="btn primary" data-act="end">Avslutt kamp</button>' +
            '<button class="btn ghost" data-act="run">▶ Spill videre</button>';
  } else {
    ctrls = '<button class="btn primary" data-act="run">▶ ' + (m.elapsed > 0 ? 'Fortsett' : 'Start') + '</button>';
  }
  const clock =
    '<div class="clockcard">' +
      '<div class="clockhead">' +
        '<span class="mname">' + esc(m.name) + '</span>' +
        '<span class="mmeta">' + (m.periods > 1 ? m.period + '. omgang · ' : '') +
          Math.round(m.durationSec / 60) + ' min · ' + m.onFieldCount + 'er</span>' +
      '</div>' +
      '<div class="clock mono' + (m.running ? '' : ' paused') + '" id="clock" data-act="clockmode"></div>' +
      '<div class="clocksub" id="clocksub"></div>' +
      '<div class="bar"><i id="pbar"></i></div>' +
      '<div class="ctrls">' + ctrls +
        '<button class="btn ghost" data-act="menu" style="flex:0 0 56px" aria-label="Kampmeny">⋯</button>' +
      '</div>' +
    '</div>';

  /* ---- pause: trekk fra tid klokka gikk for mye ---- */
  let fixcard = '';
  if (!m.finished && !m.running && overrun(m) > 0) {
    const o = overrun(m);
    const steps = [15, 30, 60, 120].filter(x => x < o - 0.5);
    const label = x => (x < 60 ? '−' + x + ' s' : '−' + (x / 60) + ' min');
    fixcard =
      '<div class="card fixcard">' +
        '<div class="fhead">Klokka gikk <b class="mono">' + fmt(o) + '</b> forbi ' +
          (m.period < m.periods ? m.period + '. omgang' : 'full tid') + '</div>' +
        '<div class="fnote">Var noe av det pause og ikke spill? Trekk det fra de ' +
          m.onField.length + ' som står på banen, så de ikke får betalt for tid ' +
          'det ikke ble spilt.</div>' +
        '<div class="rowbtns">' +
          steps.map(x => '<button class="btn" data-act="rollback" data-d="' + x + '">' +
            label(x) + '</button>').join('') +
          '<button class="btn" data-act="rollback" data-d="all">−alt (' + fmt(o) + ')</button>' +
        '</div>' +
      '</div>';
  }

  /* ---- forslag ---- */
  let sugg;
  if (m.finished) {
    sugg = '';
  } else if (pairs.length) {
    const rows = pairs.map(p =>
      '<div class="swap">' +
        (p.out
          ? '<span class="off"><span class="pill">' + esc(pnum(p.out)) + '</span>' +
            '<span class="nm">' + esc(pname(p.out)) + '</span>' +
            '<span class="t mono">' + fmt(m.sec[p.out] || 0) + '</span></span>'
          : '<span class="off"><span class="nm" style="color:var(--muted)">ledig plass</span></span>') +
        '<span class="arrow">→</span>' +
        '<span class="on"><span class="pill">' + esc(pnum(p.in)) + '</span>' +
          '<span class="nm">' + esc(pname(p.in)) + '</span>' +
          '<span class="t mono">' + fmt(m.sec[p.in] || 0) + '</span></span>' +
        '<button class="btn sm" data-act="apply1" data-out="' + (p.out || '') + '" data-in="' + p.in + '">✓</button>' +
      '</div>').join('');
    sugg =
      '<div class="sugg' + (m.nudged ? ' nudge' : '') + '">' +
        '<h3>Foreslått bytte <span class="mmeta" id="nextsub"></span></h3>' + rows +
        '<div class="rowbtns">' +
          '<button class="btn primary" data-act="applyall">Bekreft bytte' + (pairs.length > 1 ? ' (' + pairs.length + ')' : '') + '</button>' +
          '<button class="btn ghost" data-act="snooze">Ikke nå</button>' +
        '</div>' +
        '<p class="hint">Klokka går hele tida. Byttet gjelder fra du trykker bekreft.</p>' +
      '</div>';
  } else {
    const benchN = Object.keys(L).filter(id => L[id].share > 0 && !L[id].locked && !m.onField.includes(id)).length;
    sugg = '<div class="sugg"><h3>Foreslått bytte <span class="mmeta" id="nextsub"></span></h3>' +
      '<div class="noswap">' + (benchN === 0
        ? 'Ingen på benken å bytte inn.'
        : 'Spilletida er jevn nok akkurat nå – ingen bytte trengs.') + '</div></div>';
  }

  /* ---- lister ---- */
  const onF = m.onField.slice().sort((x, y) => bal(y) - bal(x));
  const bench = Object.keys(L).filter(id => !m.onField.includes(id) && L[id].share > 0)
    .sort((x, y) => bal(x) - bal(y));
  const outs = Object.keys(L).filter(id => !m.onField.includes(id) && L[id].share <= 0);

  const row = (id, where) => {
    const l = L[id] || { share: 1, locked: false };
    const tags = [];
    if (l.locked) tags.push('🔒 låst');
    if (l.share > 0 && l.share < 1) tags.push(Math.round(l.share * 100) + '% andel');
    if (l.share <= 0) tags.push('ute');
    return '<div class="prow tap' + (where === 'field' ? ' onfield' : '') +
        (where === 'out' ? ' out' : '') + (sel === id ? ' sel' : '') + '" data-act="pick" data-id="' + id + '">' +
      '<span class="num2">' + esc(pnum(id)) + '</span>' +
      '<span class="who"><b>' + esc(pname(id)) + '</b><small>' + (tags.join(' · ') || (where === 'field' ? 'på banen' : 'på benken')) + '</small></span>' +
      '<span class="tm"><b class="mono" data-pt="' + id + '">0:00</b>' +
        '<small class="mono" data-pb="' + id + '"></small></span>' +
      '<button class="dots" data-act="pmenu" data-id="' + id + '" aria-label="Mer om ' + esc(pname(id)) + '">⋯</button>' +
    '</div>';
  };

  const notIn = T().squad.filter(p => !L[p.id]);
  const addBtn = notIn.length && !m.finished
    ? '<button class="btn ghost" data-act="addplayer">Legg til spiller i kampen</button>' : '';

  const tbar = S.teams.length > 1
    ? '<header class="topbar"><h1>' + esc(T().name) + '</h1>' + teamBtnHTML() + '</header>' : '';

  return tbar + clock + fixcard + sugg +
    '<div class="sect"><h2>På banen (' + m.onField.length + '/' + m.onFieldCount + ')</h2>' +
      (sel ? '<span class="mmeta">Trykk på en annen spiller for å bytte</span>' : '') + '</div>' +
    '<div class="rows">' + (onF.map(id => row(id, 'field')).join('') || '<div class="empty">Ingen på banen</div>') + '</div>' +
    '<div class="sect"><h2>Benk (' + bench.length + ')</h2></div>' +
    '<div class="rows">' + (bench.map(id => row(id, 'bench')).join('') || '<div class="empty">Tom benk</div>') + '</div>' +
    (outs.length ? '<div class="sect"><h2>Ute (' + outs.length + ')</h2></div><div class="rows">' +
      outs.map(id => row(id, 'out')).join('') + '</div>' : '') +
    '<div class="spacer"></div>' +
    (addBtn ? '<div class="rowbtns">' + addBtn + '</div>' : '') +
    (m.finished ? '' : '<div class="rowbtns"><button class="btn danger" data-act="end">Avslutt kampen</button></div>') +
    '<div class="spacer"></div>';
}

function paintMatch(m, b, pairs) {
  const c = $('#clock'); if (!c) return;
  const over = overrun(m);
  const left = Math.max(0, m.durationSec - m.elapsed);
  c.textContent = over > 0 ? '+' + fmt(over) : (S.countdown ? fmt(left) : fmt(m.elapsed));
  c.classList.toggle('paused', !m.running);
  const pEnd = periodEnd(m);
  let sub;
  if (m.finished) sub = 'Kampen er avsluttet';
  else if (over > 0) {
    const what = m.period < m.periods ? m.period + '. omgang' : 'Full tid';
    sub = m.running
      ? what + ' er ute · spilt ' + fmt(over) + ' over — pause når dommeren blåser'
      : what + ' · klokka gikk ' + fmt(over) + ' over';
  } else if (inBreak(m)) sub = 'Pause etter ' + m.period + '. omgang';
  else sub = (S.countdown ? fmt(m.elapsed) + ' spilt' : fmt(left) + ' igjen') +
    (m.periods > 1 ? ' · omgangen slutter ' + fmt(pEnd) : '');
  $('#clocksub').textContent = sub;
  c.classList.toggle('over', over > 0 && !m.finished);
  $('#pbar').style.width = clamp(m.elapsed / m.durationSec * 100, 0, 100) + '%';

  const ns = $('#nextsub');
  if (ns) {
    if (!m.running) ns.textContent = '';
    else if (!pairs.length) ns.textContent = '';
    else {
      const t = m.interval * 60 - (m.elapsed - m.lastSub);
      ns.textContent = t > 0 ? 'om ' + fmt(t) : 'nå!';
    }
  }
  $$('[data-pt]').forEach(e => { e.textContent = fmt(m.sec[e.dataset.pt] || 0); });
  $$('[data-pb]').forEach(e => {
    const id = e.dataset.pb, L = m.lineup[id];
    if (L && L.locked) { e.textContent = 'låst'; e.className = 'mono bal-ok'; return; }
    const v = b[id] ? b[id].bal : 0;
    e.textContent = fmtSign(v);
    e.className = 'mono ' + balClass(v, m.threshold);
  });
}

/* ------------------------------- SHEETS ------------------------------- */

/* Lagvelger. Har du bare ett lag, skal appen se ut som før – da vises
   knappen kun i Tropp, som en diskret måte å oppdage funksjonen på.      */
function teamBtnHTML(always) {
  const multi = S.teams.length > 1;
  if (!multi && !always) return '';
  return '<button class="btn sm teamsel" data-act="teams">' +
    (multi ? esc(T().name) + ' ▾' : '+ Legg til lag') + '</button>';
}
function teamsSheet() {
  const rows = S.teams.map(t => {
    const act = t.id === S.teamId;
    const kamper = t.matches.length;
    return '<div class="prow tap' + (act ? ' sel' : '') + '" data-act="team-pick" data-id="' + t.id + '">' +
      '<span class="num2">' + esc((t.name || '?').trim().slice(0, 2).toUpperCase()) + '</span>' +
      '<span class="who"><b>' + esc(t.name) + '</b><small>' +
        t.squad.length + ' spiller' + (t.squad.length === 1 ? '' : 'e') + ' · ' +
        kamper + ' kamp' + (kamper === 1 ? '' : 'er') + (act ? ' · aktivt nå' : '') +
      '</small></span>' +
      '<button class="dots" data-act="team-rename" data-id="' + t.id + '" aria-label="Endre navn på ' + esc(t.name) + '">✎</button>' +
    '</div>';
  }).join('');
  openSheet(
    '<h2>Lag</h2>' +
    '<div class="rows">' + rows + '</div>' +
    '<p class="hint">Hvert lag har egen tropp, egne kamper og egen spilletidsbalanse. ' +
      'Ingenting blandes mellom lag.</p>' +
    '<div class="rowbtns"><button class="btn primary" data-act="team-new">Nytt lag</button>' +
      (S.teams.length > 1
        ? '<button class="btn danger" data-act="team-del" data-id="' + S.teamId + '">Slett ' + esc(T().name) + '</button>'
        : '') +
    '</div>' +
    '<div class="spacer"></div><button class="btn big" data-close>Lukk</button>'
  );
}
/* Bytter aktivt lag. Kamp som går blir pauset – den hører til det andre laget. */
function switchTeam(id) {
  const m = cur();
  if (m && m.running) { flush(); m.running = false; releaseWake(); }
  S.teamId = id; resetView();
  save(true); closeSheet();
  go(cur() ? 'match' : (T().squad.length ? 'setup' : 'squad'));
}

/* Blink et tall som nettopp endra seg. Uten dette ser et trykk på «+30 s» ut
   som ingenting – tallet står et annet sted på skjermen enn knappen.        */
function flashEl(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;            // tving reflow, ellers starter ikke animasjonen på nytt
  el.classList.add('flash');
}

/* Oppdaterer tallene i spiller-arket der de står, i stedet for å bygge hele
   arket på nytt: innerHTML nullstiller rullingen, og da hopper arket til
   toppen for hvert eneste trykk – bort fra knappene du holder på med.      */
function paintPlayerSheet(id, note, warn) {
  const m = cur(); if (!m) return;
  const b = balances();
  $$('[data-ph-sec="' + id + '"]').forEach(e => { e.textContent = fmt(m.sec[id] || 0); flashEl(e); });
  $$('[data-ph-bal="' + id + '"]').forEach(e => { e.textContent = fmtSign(b[id] ? b[id].bal : 0); });
  const n = $('[data-ph-note="' + id + '"]');
  if (n) { n.textContent = note || ''; n.className = 'adjnote' + (warn ? ' warn' : ''); }
}

function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; }

function playerSheet(id) {
  const m = cur(); if (!m) return;
  const L = m.lineup[id] || { share: 1, locked: false };
  const onF = m.onField.includes(id);
  const shares = [1, 0.75, 0.5, 0.25, 0];
  openSheet(
    '<div class="shead"><span class="num2">' + esc(pnum(id)) + '</span>' +
      '<div><b>' + esc(pname(id)) + '</b><small>' +
      '<span data-ph-sec="' + id + '">' + fmt(m.sec[id] || 0) + '</span> i denne kampen · ' +
      (L.locked ? 'låst' : 'saldo <span data-ph-bal="' + id + '">' +
        fmtSign(balances()[id] ? balances()[id].bal : 0) + '</span>') + '</small></div></div>' +
    '<div class="sgroup"><span>På banen</span><div class="rowbtns">' +
      (onF
        ? '<button class="btn" data-act="ph-off" data-id="' + id + '">Ta av banen</button>'
        : '<button class="btn" data-act="ph-on" data-id="' + id + '">Sett inn på banen</button>') +
    '</div></div>' +
    '<div class="sgroup"><span>Hvor mye skal spilleren spille?</span><div class="chips">' +
      shares.map(s => '<button class="chip' + (Math.abs(L.share - s) < .01 ? ' on' : '') +
        '" data-act="ph-share" data-id="' + id + '" data-share="' + s + '">' +
        (s === 0 ? 'Ute / skadet' : Math.round(s * 100) + '%') + '</button>').join('') +
    '</div><p class="hint">Ute = teller ikke med i fordelingen. Lavere prosent = skal spille mindre enn de andre.</p></div>' +
    '<div class="sgroup"><span>Rotasjon</span><div class="rowbtns">' +
      '<button class="btn" data-act="ph-lock" data-id="' + id + '">' +
        (L.locked ? '🔓 Ta med i rotasjonen' : '🔒 Lås (f.eks. keeper)') + '</button>' +
    '</div><p class="hint">Låst spiller blir aldri foreslått byttet, og tida deres teller ikke i fordelingen.</p></div>' +
    '<div class="sgroup"><span>Rett opp spilletid</span>' +
      '<div class="adjval"><b class="mono" data-ph-sec="' + id + '">' + fmt(m.sec[id] || 0) + '</b>' +
        '<small>spilt i denne kampen' +
        (L.locked ? '' : ' · saldo <span data-ph-bal="' + id + '">' +
          fmtSign(balances()[id] ? balances()[id].bal : 0) + '</span>') + '</small></div>' +
      '<div class="adjnote" data-ph-note="' + id + '"></div>' +
      '<div class="rowbtns">' +
      '<button class="btn" data-act="ph-adj" data-id="' + id + '" data-d="-60">−1 min</button>' +
      '<button class="btn" data-act="ph-adj" data-id="' + id + '" data-d="-30">−30 s</button>' +
      '<button class="btn" data-act="ph-adj" data-id="' + id + '" data-d="30">+30 s</button>' +
      '<button class="btn" data-act="ph-adj" data-id="' + id + '" data-d="60">+1 min</button>' +
    '</div></div>' +
    '<div class="spacer"></div><button class="btn big" data-close>Lukk</button>'
  );
}

function matchMenuSheet() {
  const m = cur(); if (!m) return;
  openSheet(
    '<h2>Kampen</h2><div class="shead"><div><b>' + esc(m.name) + '</b><small>' +
      Math.round(m.durationSec / 60) + ' min · ' + m.onFieldCount + ' på banen · ' +
      m.periods + ' omgang' + (m.periods > 1 ? 'er' : '') + '</small></div></div>' +
    '<div class="sgroup"><span>Kamplengde</span><div class="rowbtns">' +
      '<button class="btn" data-act="mm-dur" data-d="-60">−1 min</button>' +
      '<button class="btn" data-act="mm-dur" data-d="60">+1 min</button>' +
    '</div></div>' +
    '<div class="sgroup"><span>Rett opp klokka</span>' +
      '<div class="adjval"><b class="mono" data-mm-clock="1">' + fmt(m.elapsed) + '</b>' +
        '<small>på klokka</small></div>' +
      '<div class="rowbtns">' +
      '<button class="btn" data-act="mm-clock" data-d="-60">−1 min</button>' +
      '<button class="btn" data-act="mm-clock" data-d="-30">−30 s</button>' +
      '<button class="btn" data-act="mm-clock" data-d="30">+30 s</button>' +
    '</div><p class="hint">Justerer bare klokka, ikke spilletida til spillerne.</p></div>' +
    '<div class="sgroup"><span>Bytteforslag</span>' +
      '<label class="field"><span>Foreslå bytte hvert (min)</span>' +
        '<input type="number" min="1" max="30" value="' + m.interval + '" data-act="mm-interval"></label>' +
      '<label class="field"><span>Bytter per runde</span>' +
        '<input type="number" min="1" max="11" value="' + m.maxSwaps + '" data-act="mm-maxswaps"></label>' +
      '<label class="field"><span>Slingringsmonn (sek)</span>' +
        '<input type="number" min="0" max="600" step="10" value="' + m.threshold + '" data-act="mm-threshold"></label>' +
    '</div>' +
    '<div class="sgroup"><span>Annet</span><div class="rowbtns">' +
      '<button class="btn" data-act="mm-rename">Endre navn</button>' +
      '<button class="btn danger" data-act="mm-delete">Slett kampen</button>' +
    '</div></div>' +
    '<div class="spacer"></div><button class="btn big" data-close>Lukk</button>'
  );
}

function addPlayerSheet() {
  const m = cur(); if (!m) return;
  const notIn = T().squad.filter(p => !m.lineup[p.id]);
  openSheet('<h2>Legg til i kampen</h2><div class="rows">' +
    (notIn.length ? notIn.map(p =>
      '<div class="srow"><span class="num2">' +
      esc(p.number || '–') + '</span><span class="who"><b>' + esc(p.name) + '</b></span>' +
      '<button class="btn sm primary" data-act="ap-add" data-id="' + p.id + '">Legg til</button></div>').join('')
      : '<div class="empty">Alle i troppen er med.</div>') +
    '</div><div class="spacer"></div><button class="btn big" data-close>Lukk</button>');
}

function squadSheet(id) {
  const p = P(id); if (!p) return;
  const b = balances()[id] || { sec: 0 };
  openSheet(
    '<h2>Spiller</h2>' +
    '<div class="grid2">' +
      '<label class="field"><span>Nummer</span><input id="sq-num" type="text" inputmode="numeric" value="' + esc(p.number || '') + '"></label>' +
      '<label class="field"><span>Navn</span><input id="sq-nm" type="text" value="' + esc(p.name) + '"></label>' +
    '</div>' +
    '<p class="hint">Spilt så langt i turneringen: ' + fmt(b.sec) + '</p>' +
    '<div class="rowbtns"><button class="btn primary" data-act="sq-save" data-id="' + id + '">Lagre</button>' +
    '<button class="btn danger" data-act="sq-del" data-id="' + id + '">Slett</button></div>' +
    '<div class="spacer"></div><button class="btn big" data-close>Lukk</button>'
  );
}

/* ------------------------------- TROPP ------------------------------- */

function renderSquad() {
  $('#q-count').textContent = T().squad.length;
  const b = balances();
  $('#squad-list').innerHTML = T().squad.length
    ? T().squad.map(p =>
      '<div class="prow tap" data-act="sq-menu" data-id="' + p.id + '">' +
      '<span class="num2">' + esc(p.number || '–') + '</span>' +
      '<span class="who"><b>' + esc(p.name) + '</b><small>' + fmt(b[p.id] ? b[p.id].sec : 0) + ' spilt i turneringen</small></span>' +
      '<button class="dots" data-act="sq-menu" data-id="' + p.id + '" aria-label="Endre ' + esc(p.name) + '">✎</button></div>').join('')
    : '<div class="empty">Ingen spillere ennå. Legg dem inn over.</div>';
}

function addPlayers(text, numHint) {
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return 0;
  let n = 0;
  lines.forEach((line, i) => {
    let num = '', name = line;
    let mm = line.match(/^(\d{1,3})[\s.,:;-]+(.+)$/);
    if (mm) { num = mm[1]; name = mm[2]; }
    else { mm = line.match(/^(.+?)[\s.,:;-]+(\d{1,3})$/); if (mm) { name = mm[1]; num = mm[2]; } }
    if (!num && i === 0 && numHint) num = numHint;
    name = name.trim();
    if (!name) return;
    T().squad.push({ id: uid(), name, number: num });
    n++;
  });
  return n;
}

/* ------------------------------- OPPSETT ------------------------------- */

let setup = null;
function setupInit() {
  const st = T().settings;
  const b = balances();
  setup = {
    name: '',
    duration: st.duration, onField: st.onField, periods: st.periods,
    interval: st.interval, maxSwaps: st.maxSwaps, threshold: st.threshold,
    lineup: {}, start: []
  };
  T().squad.forEach(p => { setup.lineup[p.id] = { share: 1, locked: false }; });
  autoStart();
}
function autoStart() {
  const b = balances();
  const avail = Object.keys(setup.lineup).filter(id => setup.lineup[id].share > 0);
  const locked = avail.filter(id => setup.lineup[id].locked);
  const rest = avail.filter(id => !setup.lineup[id].locked)
    .sort((x, y) => (b[x] ? b[x].bal : 0) - (b[y] ? b[y].bal : 0));
  setup.start = locked.concat(rest).slice(0, setup.onField);
}
function renderSetup() {
  if (!setup) setupInit();
  const m = cur();
  $('#setup-warn').innerHTML = m
    ? '<div class="card" style="border-color:var(--warn)"><b>En kamp er i gang.</b>' +
      '<p class="hint">Avslutt den pågående kampen før du starter en ny.</p>' +
      '<div class="rowbtns"><button class="btn" data-act="tab" data-tab="match">Gå til kampen</button></div></div>'
    : '';
  $('#s-name').placeholder = 'Kamp ' + (T().matches.length + 1);
  $('#s-name').value = setup.name;
  $('#s-duration').value = setup.duration;
  $('#s-onfield').value = setup.onField;
  $('#s-periods').value = setup.periods;
  $('#s-interval').value = setup.interval;
  $('#s-maxswaps').value = setup.maxSwaps;
  $('#s-threshold').value = setup.threshold;

  const b = balances();
  T().squad.forEach(p => { if (!setup.lineup[p.id]) setup.lineup[p.id] = { share: 1, locked: false }; });
  $('#setup-players').innerHTML = T().squad.length ? T().squad.map(p => {
    const l = setup.lineup[p.id];
    return '<div class="srow"><span class="num2">' +
      esc(p.number || '–') + '</span>' +
      '<span class="who"><b>' + esc(p.name) + '</b><small class="' + balClass(b[p.id] ? b[p.id].bal : 0, setup.threshold) + '">saldo ' +
        fmtSign(b[p.id] ? b[p.id].bal : 0) + '</small></span>' +
      '<select data-act="su-share" data-id="' + p.id + '">' +
        [1, 0.75, 0.5, 0.25, 0].map(s => '<option value="' + s + '"' +
          (Math.abs(l.share - s) < .01 ? ' selected' : '') + '>' +
          (s === 0 ? 'Ute' : Math.round(s * 100) + '%') + '</option>').join('') +
      '</select>' +
      '<button class="btn sm' + (l.locked ? ' primary' : ' ghost') + '" data-act="su-lock" data-id="' + p.id + '">' +
        (l.locked ? '🔒' : '🔓') + '</button></div>';
  }).join('') : '<div class="empty">Legg inn troppen først.</div>';

  $('#setup-start').innerHTML = T().squad.map(p => {
    const l = setup.lineup[p.id] || { share: 0 };
    const on = setup.start.includes(p.id);
    return '<button class="chip' + (on ? ' on' : '') + (l.share <= 0 ? ' dis' : '') +
      '" data-act="su-start" data-id="' + p.id + '">' +
      (p.number ? esc(p.number) + ' ' : '') + esc(p.name) + '</button>';
  }).join('');
  const n = setup.start.length;
  $('#setup-count').textContent = n + ' av ' + setup.onField + ' valgt' +
    (n === setup.onField ? ' ✓' : n < setup.onField ? ' – velg ' + (setup.onField - n) + ' flere' : ' – for mange');
  $('#s-start').disabled = !!m || n === 0;
}
function readSetupNumbers() {
  if (!setup) setupInit();
  const num = (sel, def, lo, hi) => {
    const v = parseInt($(sel).value, 10);
    return isNaN(v) ? def : clamp(v, lo, hi);
  };
  setup.duration = num('#s-duration', 50, 1, 120);
  setup.onField = num('#s-onfield', 7, 1, 11);
  setup.periods = num('#s-periods', 2, 1, 10);
  setup.interval = num('#s-interval', 5, 1, 30);
  setup.maxSwaps = num('#s-maxswaps', 2, 1, 11);
  setup.threshold = num('#s-threshold', 60, 0, 600);
  setup.name = $('#s-name').value.trim();
}
function startMatch() {
  readSetupNumbers();
  if (cur()) return;
  if (!setup.start.length) { alert('Velg minst én spiller til startoppstillingen.'); return; }
  Object.keys(setup.lineup).forEach(id => {
    if (setup.lineup[id].share <= 0) setup.start = setup.start.filter(x => x !== id);
  });
  T().settings = {
    duration: setup.duration, onField: setup.onField, periods: setup.periods,
    interval: setup.interval, maxSwaps: setup.maxSwaps, threshold: setup.threshold
  };
  const lineup = {};
  Object.keys(setup.lineup).forEach(id => { lineup[id] = { share: setup.lineup[id].share, locked: setup.lineup[id].locked }; });
  const m = newMatch({
    name: setup.name || ('Kamp ' + (T().matches.length + 1)),
    duration: setup.duration, onField: setup.onField, periods: setup.periods,
    interval: setup.interval, maxSwaps: setup.maxSwaps, threshold: setup.threshold,
    lineup, onField0: setup.start
  });
  T().matches.push(m);
  T().currentId = m.id;
  setup = null;
  save(true);
  go('match');
}

/* ------------------------------ STATISTIKK ------------------------------ */

function renderStats() {
  const b = balances();
  const ms = T().matches;
  const anyLock = Object.keys(b).some(id => b[id].lock > 0.5);
  const thr = T().settings.threshold;

  let html = '';
  if (!T().squad.length) {
    html = '<div class="card"><div class="empty">Ingen spillere ennå.</div></div>';
  } else {
    const rows = T().squad.slice().sort((x, y) => b[x.id].bal - b[y.id].bal).map(p => {
      const o = b[p.id];
      return '<tr><td>' + (p.number ? '<b>' + esc(p.number) + '</b> ' : '') + esc(p.name) + '</td>' +
        '<td class="mono">' + fmt(o.sec) + '</td>' +
        (anyLock ? '<td class="mono">' + (o.lock > 0.5 ? fmt(o.lock) : '–') + '</td>' : '') +
        '<td class="mono">' + fmt(o.tgt) + '</td>' +
        '<td class="mono ' + balClass(o.bal, thr) + '">' + fmtSign(o.bal) + '</td>' +
        ms.map(m => '<td class="mono">' + (m.lineup[p.id] ? fmt(m.sec[p.id] || 0) : '–') + '</td>').join('') +
        '</tr>';
    }).join('');
    html += '<div class="card"><h2>Spilletid i turneringen</h2><div class="tablewrap"><table>' +
      '<thead><tr><th>Spiller</th><th>Spilt</th>' + (anyLock ? '<th>Låst</th>' : '') +
      '<th>Bør</th><th>Diff</th>' +
      ms.map((m, i) => '<th>K' + (i + 1) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hint">«Bør» = jevn fordeling av spilletida, justert for andel og fravær. ' +
      'Positiv diff = har spilt mer enn sin del.' + (anyLock ? ' «Låst» tid (f.eks. keeper) teller ikke i fordelingen.' : '') + '</p></div>';
  }

  html += '<div class="card"><h2>Kamper (' + ms.length + ')</h2><div class="rows">' +
    (ms.length ? ms.map((m, i) => {
      const on = m.id === T().currentId;
      return '<div class="prow"><span class="num2">' + (i + 1) + '</span>' +
        '<span class="who"><b>' + esc(m.name) + '</b><small>' + fmt(m.elapsed) + ' av ' +
        Math.round(m.durationSec / 60) + ' min' + (on ? ' · i gang' : m.finished ? ' · ferdig' : ' · ikke avsluttet') + '</small></span>' +
        (on ? '<button class="btn sm" data-act="tab" data-tab="match">Åpne</button>'
            : '<button class="btn sm" data-act="reopen" data-id="' + m.id + '">Åpne</button>') +
        '<button class="dots" data-act="del-match" data-id="' + m.id + '" aria-label="Slett ' + esc(m.name) + '">✕</button></div>';
    }).join('') : '<div class="empty">Ingen kamper registrert.</div>') + '</div></div>';

  let berget = '';
  try { berget = localStorage.getItem(KEY + '-berget') || ''; } catch (e) {}

  html += '<div class="card"><h2>Data</h2><div class="rowbtns">' +
    '<button class="btn" data-act="export">Ta backup</button>' +
    '<button class="btn" data-act="import">Les inn backup</button></div>' +
    (berget ? '<div class="rowbtns"><button class="btn" data-act="rescue">' +
      'Gjenopprett berget data</button></div>' +
      '<p class="hint">Appen fant lagrede data den ikke kjente formatet på, og tok ' +
      'vare på dem i stedet for å overskrive.</p>' : '') +
    '<div class="rowbtns"><button class="btn danger" data-act="new-cup">Ny turnering</button>' +
    '<button class="btn danger" data-act="wipe">Slett alt</button></div>' +
    '<p class="hint">«Ny turnering» nullstiller spilletida, men beholder troppen.</p></div>';

  html += '<div class="version">Spilletid v' + esc(APP_VERSION) + '</div>';

  $('#stats-body').innerHTML = html;
}

/* ------------------------------ BACKUP ------------------------------ */

function exportData() {
  flush();
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'spilletid-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = migrate(JSON.parse(r.result));
        if (!p) throw new Error('feil format');
        const n = p.teams.length;
        if (!confirm('Erstatte alle data med backupen? Den inneholder ' + n + ' lag.')) return;
        S = p; resetView(); releaseWake(); save(true); go('stats');
      } catch (e) { alert('Kunne ikke lese filen: ' + e.message); }
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ------------------------------ HANDLINGER ------------------------------ */

document.addEventListener('click', ev => {
  const closer = ev.target.closest('[data-close]');
  if (closer) { closeSheet(); return; }
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const a = t.dataset.act, id = t.dataset.id, m = cur();

  switch (a) {
    case 'tab': go(t.dataset.tab); break;
    case 'clockmode': S.countdown = !S.countdown; save(); lastSig = ''; paintAll(); break;
    case 'run': toggleRun(); break;
    case 'next-period': nextPeriod(); break;
    case 'rollback': {
      if (!m) break;
      flush();
      const o = overrun(m);
      rollback(m, t.dataset.d === 'all' ? o : Math.min(parseInt(t.dataset.d, 10) || 0, o));
      save(); lastSig = ''; paintAll(); break;
    }
    case 'end':
      if (m && confirm('Avslutte «' + m.name + '»? Spilletida blir lagret i turneringen.')) endMatch();
      break;
    case 'applyall': {
      if (!m) break;
      applyPairs(suggest(m, balances()));
      break;
    }
    case 'apply1':
      doSwap(t.dataset.out || null, t.dataset.in);
      break;
    case 'snooze': snooze(); break;
    case 'pick': {
      if (!m) break;
      if (sel === id) { sel = null; lastSig = ''; renderMatch(); break; }
      if (!sel) { sel = id; lastSig = ''; renderMatch(); break; }
      const aOn = m.onField.includes(sel), bOn = m.onField.includes(id);
      const L = m.lineup;
      if (aOn && !bOn) { if (L[id] && L[id].share > 0) doSwap(sel, id); else { alert(pname(id) + ' står som ute. Endre andel først (⋯).'); sel = null; lastSig = ''; renderMatch(); } }
      else if (!aOn && bOn) { if (L[sel] && L[sel].share > 0) doSwap(id, sel); else { alert(pname(sel) + ' står som ute. Endre andel først (⋯).'); sel = null; lastSig = ''; renderMatch(); } }
      else { sel = id; lastSig = ''; renderMatch(); }
      break;
    }
    case 'pmenu': playerSheet(id); break;
    case 'menu': matchMenuSheet(); break;
    case 'addplayer': addPlayerSheet(); break;

    /* --- spiller-sheet --- */
    case 'ph-off': doSwap(id, null); closeSheet(); break;
    case 'ph-on':
      if (m && m.lineup[id] && m.lineup[id].share <= 0) m.lineup[id].share = 1;
      doSwap(null, id); closeSheet(); break;
    case 'ph-share': {
      if (!m) break;
      flush();
      const s = parseFloat(t.dataset.share);
      m.lineup[id] = m.lineup[id] || { share: 1, locked: false };
      m.lineup[id].share = s;
      if (s <= 0) m.onField = m.onField.filter(x => x !== id);
      save(); lastSig = ''; playerSheet(id); paintAll();
      break;
    }
    case 'ph-lock': {
      if (!m) break;
      flush();
      m.lineup[id] = m.lineup[id] || { share: 1, locked: false };
      m.lineup[id].locked = !m.lineup[id].locked;
      save(); lastSig = ''; playerSheet(id); paintAll();
      break;
    }
    case 'ph-adj': {
      if (!m) break;
      flush();
      const d = parseInt(t.dataset.d, 10);
      const før = m.sec[id] || 0;
      m.sec[id] = Math.max(0, før + d);
      /* Bunnen er 0:00. Ber du om −1 min på en som har spilt 0:20, blir det
         bare −0:20 – si fra, ellers ser knappen ut til å ikke virke.        */
      const gjort = Math.round(m.sec[id] - før);
      const kuttet = gjort !== d;
      const note = !kuttet
        ? (d > 0 ? '+' + fmt(d) + ' lagt til' : '−' + fmt(-d) + ' trukket fra')
        : gjort === 0
          ? 'Spilletida er allerede 0:00 – kan ikke gå lavere'
          : 'Kunne bare trekke fra ' + fmt(Math.abs(gjort)) + ' – spilletida er nede i 0:00';
      save(); lastSig = ''; paintPlayerSheet(id, note, kuttet); paintAll();
      break;
    }

    /* --- kamp-meny --- */
    case 'mm-dur': {
      if (!m) break;
      flush();
      m.durationSec = clamp(m.durationSec + parseInt(t.dataset.d, 10), 60, 240 * 60);
      syncChime(m);
      save(); lastSig = ''; matchMenuSheet(); paintAll(); break;
    }
    case 'mm-clock': {
      if (!m) break;
      flush();
      m.elapsed = Math.max(0, m.elapsed + parseInt(t.dataset.d, 10));
      syncChime(m);
      /* Klokka den retter på ligger bak arket. Vis den i arket, og blink.  */
      const c2 = $('[data-mm-clock]');
      if (c2) { c2.textContent = fmt(m.elapsed); flashEl(c2); }
      save(); lastSig = ''; paintAll(); break;
    }
    case 'mm-rename': {
      if (!m) break;
      const n = prompt('Navn på kampen', m.name);
      if (n && n.trim()) { m.name = n.trim(); save(); lastSig = ''; closeSheet(); paintAll(); }
      break;
    }
    case 'mm-delete': {
      if (!m) break;
      if (confirm('Slette kampen og all spilletid i den?')) {
        T().matches = T().matches.filter(x => x.id !== m.id);
        T().currentId = null; save(true); closeSheet(); go('stats');
      }
      break;
    }

    /* --- legg til spiller i kamp --- */
    case 'ap-add': {
      if (!m) break;
      flush();
      m.lineup[id] = { share: 1, locked: false };
      m.sec[id] = m.sec[id] || 0; m.lock[id] = m.lock[id] || 0; m.tgt[id] = m.tgt[id] || 0;
      save(); lastSig = ''; addPlayerSheet(); paintAll(); break;
    }

    /* --- oppsett --- */
    case 'su-lock': {
      readSetupNumbers();
      setup.lineup[id].locked = !setup.lineup[id].locked;
      renderSetup(); break;
    }
    case 'su-start': {
      readSetupNumbers();
      if (setup.lineup[id].share <= 0) { alert(pname(id) + ' står som ute i dag.'); break; }
      if (setup.start.includes(id)) setup.start = setup.start.filter(x => x !== id);
      else setup.start.push(id);
      renderSetup(); break;
    }

    /* --- tropp --- */
    case 'sq-menu': squadSheet(id); break;
    case 'sq-save': {
      const p = P(id); if (!p) break;
      const nm = $('#sq-nm').value.trim();
      if (!nm) { alert('Navn kan ikke være tomt.'); break; }
      p.name = nm; p.number = $('#sq-num').value.trim();
      save(true); closeSheet(); paintAll(); break;
    }
    case 'sq-del': {
      const p = P(id); if (!p) break;
      if (!confirm('Slette ' + p.name + ' fra troppen? Spilletid i ferdige kamper blir liggende.')) break;
      T().squad = T().squad.filter(x => x.id !== id);
      const mm = cur();
      if (mm) { delete mm.lineup[id]; mm.onField = mm.onField.filter(x => x !== id); }
      if (setup) { delete setup.lineup[id]; setup.start = setup.start.filter(x => x !== id); }
      save(true); closeSheet(); paintAll(); break;
    }

    /* --- statistikk --- */
    case 'reopen': {
      if (cur()) { alert('Avslutt den pågående kampen først.'); break; }
      const mm = T().matches.find(x => x.id === id); if (!mm) break;
      mm.finished = false; mm.running = false; mm.lastTick = Date.now();
      T().currentId = id; save(true); go('match'); break;
    }
    case 'del-match': {
      const mm = T().matches.find(x => x.id === id); if (!mm) break;
      if (!confirm('Slette «' + mm.name + '»?')) break;
      T().matches = T().matches.filter(x => x.id !== id);
      if (T().currentId === id) T().currentId = null;
      save(true); paintAll(); break;
    }
    /* --- lag --- */
    case 'teams': teamsSheet(); break;
    case 'team-pick': if (id !== S.teamId) switchTeam(id); else closeSheet(); break;
    case 'team-new': {
      const n = prompt('Navn på laget');
      if (!n || !n.trim()) break;
      const t2 = blankTeam(n.trim());
      S.teams.push(t2);
      switchTeam(t2.id);
      break;
    }
    case 'team-rename': {
      const t2 = S.teams.find(x => x.id === id); if (!t2) break;
      const n = prompt('Navn på laget', t2.name);
      if (n && n.trim()) { t2.name = n.trim(); save(true); teamsSheet(); paintAll(); }
      break;
    }
    case 'team-del': {
      if (S.teams.length < 2) break;
      const t2 = S.teams.find(x => x.id === id); if (!t2) break;
      if (!confirm('Slette laget ' + t2.name + ' med ' + t2.squad.length + ' spillere og ' +
        t2.matches.length + ' kamper? Dette kan ikke angres.')) break;
      S.teams = S.teams.filter(x => x.id !== id);
      if (S.teamId === id) S.teamId = S.teams[0].id;
      resetView(); save(true); closeSheet(); paintAll();
      break;
    }

    case 'rescue': {
      let raw = '';
      try { raw = localStorage.getItem(KEY + '-berget') || ''; } catch (e) {}
      if (!raw) break;
      let p = null;
      try { p = migrate(JSON.parse(raw)); } catch (e) {}
      if (!p) { alert('Klarte ikke å lese de bergede dataene.'); break; }
      if (!confirm('Erstatte alt med de bergede dataene?')) break;
      S = p; resetView(); releaseWake(); save(true);
      try { localStorage.removeItem(KEY + '-berget'); } catch (e) {}
      go('stats'); break;
    }
    case 'export': exportData(); break;
    case 'import': importData(); break;
    case 'new-cup': {
      if (!confirm('Nullstille all spilletid for ' + T().name + ' og starte ny turnering? Troppen blir beholdt.')) break;
      T().matches = []; T().currentId = null; resetView(); save(true); paintAll(); break;
    }
    case 'wipe': {
      if (!confirm('Slette ALLE data for alle lag, også troppene?')) break;
      S = blank(); resetView(); save(true); go('squad'); break;
    }
  }
});

document.addEventListener('change', ev => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const m = cur();
  switch (t.dataset.act) {
    case 'su-share': {
      readSetupNumbers();
      const id = t.dataset.id, s = parseFloat(t.value);
      setup.lineup[id].share = s;
      if (s <= 0) setup.start = setup.start.filter(x => x !== id);
      renderSetup(); break;
    }
    case 'mm-interval': case 'mm-maxswaps': case 'mm-threshold': {
      if (!m) break;
      const key = { 'mm-interval': 'interval', 'mm-maxswaps': 'maxSwaps', 'mm-threshold': 'threshold' }[t.dataset.act];
      const lim = { interval: [1, 30], maxSwaps: [1, 11], threshold: [0, 600] }[key];
      const v = parseInt(t.value, 10);
      m[key] = isNaN(v) ? m[key] : clamp(v, lim[0], lim[1]);
      t.value = m[key];
      save(); lastSig = ''; break;
    }
  }
});

$$('#tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

/* oppsett-felt */
['#s-duration', '#s-onfield', '#s-periods'].forEach(s => {
  $(s).addEventListener('change', () => { readSetupNumbers(); autoStart(); renderSetup(); });
});
['#s-interval', '#s-maxswaps', '#s-threshold', '#s-name'].forEach(s => {
  $(s).addEventListener('change', () => { readSetupNumbers(); renderSetup(); });
});
$('#s-auto').addEventListener('click', () => { readSetupNumbers(); autoStart(); renderSetup(); });
$('#s-all-in').addEventListener('click', () => {
  readSetupNumbers();
  Object.keys(setup.lineup).forEach(id => { setup.lineup[id].share = 1; });
  autoStart(); renderSetup();
});
$('#s-all-out').addEventListener('click', () => {
  readSetupNumbers();
  Object.keys(setup.lineup).forEach(id => { setup.lineup[id].share = 0; });
  setup.start = []; renderSetup();
});
$('#s-start').addEventListener('click', startMatch);

/* tropp */
function addFromInputs(text) {
  /* text: limt inn med linjeskift. Et <input> stripper linjeskift, så
     teksten må gå rett til tolkeren, ikke via feltet.                    */
  const nm = text != null ? text : $('#q-name').value;
  const num = $('#q-number').value.trim();
  if (!nm.trim()) { $('#q-name').focus(); return; }
  const n = addPlayers(nm, num);
  if (n) {
    $('#q-name').value = ''; $('#q-number').value = '';
    if (setup) T().squad.forEach(p => { if (!setup.lineup[p.id]) setup.lineup[p.id] = { share: 1, locked: false }; });
    save(true); renderSquad(); $('#q-name').focus();
  }
}
$('#q-add').addEventListener('click', addFromInputs);
$('#q-name').addEventListener('paste', e => {
  const txt = e.clipboardData && e.clipboardData.getData('text');
  if (!txt || !/\n/.test(txt.trim())) return;      // ett navn – la feltet ta det
  e.preventDefault();
  addFromInputs(txt);
});
$('#q-name').addEventListener('keydown', e => { if (e.key === 'Enter') addFromInputs(); });
$('#q-number').addEventListener('keydown', e => { if (e.key === 'Enter') $('#q-name').focus(); });

/* ------------------------------ LOOP / OPPSTART ------------------------------ */

function banner(msg) {
  const el = $('#banner');
  el.innerHTML = '<span>' + esc(msg) + '</span><button data-close-banner>OK</button>';
  el.hidden = false;
  el.querySelector('button').onclick = () => { el.hidden = true; };
}

(function init() {
  const m = cur();
  if (m && m.running) {
    const gap = (Date.now() - (m.lastTick || Date.now())) / 1000;
    if (gap < 25) { flush(); }
    else {
      m.running = false; m.lastTick = Date.now();
      banner('Appen var lukket i ' + fmt(gap) + '. Klokka er satt på pause – sjekk tida og juster med ⋯ om du trenger.');
    }
    if (m.running) requestWake();
  }
  go(m ? 'match' : (T().squad.length ? 'setup' : 'squad'));

  setInterval(() => {
    const mm = cur();
    if (mm && mm.running) { flush(); save(); }
    else releaseWake();
    if (S.tab === 'match') renderMatch();
  }, 250);

  document.addEventListener('visibilitychange', () => {
    const mm = cur();
    if (document.visibilityState === 'visible') {
      flush(); lastSig = '';
      if (S.tab === 'match') renderMatch();
      if (mm && mm.running) requestWake();
    } else { flush(); save(true); }
  });
  window.addEventListener('beforeunload', e => {
    flush(); save(true);
    const mm = cur();
    if (mm && mm.running) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
