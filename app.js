'use strict';
/* =========================================================================
   Spilletid – lagstyring for barnefotball
   Ingen backend, ingen database. Alt lagres i localStorage.
   ========================================================================= */

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

function blank() {
  return {
    v: 1,
    squad: [],
    settings: { duration: 50, onField: 7, periods: 2, interval: 5, maxSwaps: 2, threshold: 60 },
    matches: [],
    currentId: null,
    tab: 'squad',
    countdown: false
  };
}
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === 1 && Array.isArray(p.squad)) return Object.assign(blank(), p);
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

const P = id => S.squad.find(p => p.id === id);
const cur = () => S.matches.find(m => m.id === S.currentId) || null;
const pname = id => { const p = P(id); return p ? p.name : 'Ukjent'; };
const pnum = id => { const p = P(id); return p && p.number ? p.number : '–'; };

/* ============================== TID ============================== */
/* All tidsregning skjer i flush(): differansen siden forrige "tick" legges
   til klokka, til spillerne på banen, og til hver spillers "bør spille"-kvote.
   Derfor blir et bytte alltid gjeldende fra det sekundet du bekrefter det.  */

function periodEnd(m) {
  return m.durationSec * clamp(m.period, 1, m.periods) / m.periods;
}
function accrue(m, dt) {
  if (dt <= 0) return;
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
function flush(now) {
  now = now || Date.now();
  const m = cur();
  if (!m) return;
  if (!m.running) { m.lastTick = now; return; }
  let dt = (now - m.lastTick) / 1000;
  m.lastTick = now;
  if (dt <= 0) return;
  const stop = periodEnd(m);
  if (m.elapsed + dt >= stop) {
    accrue(m, Math.max(0, stop - m.elapsed));
    m.running = false;
    m.atBreak = true;
    beep();
  } else {
    accrue(m, dt);
  }
}

/* ======================= FORDELING OG FORSLAG ======================= */

/* Saldo over hele turneringen: spilt rotasjonstid minus «bør spille».
   Positiv = har spilt mer enn sin del. Negativ = skal inn.               */
function balances() {
  const b = {};
  S.squad.forEach(p => { b[p.id] = { sec: 0, lock: 0, tgt: 0, rot: 0, bal: 0 }; });
  S.matches.forEach(m => {
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
    atBreak: false, finished: false,
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
  else {
    if (m.elapsed >= periodEnd(m)) return;
    m.atBreak = false; m.running = true; m.lastTick = Date.now(); requestWake();
  }
  save(); paintAll();
}
function nextPeriod() {
  const m = cur(); if (!m) return;
  flush();
  if (m.period >= m.periods) return;
  m.period++; m.atBreak = false; m.lastSub = m.elapsed; m.nudged = false;
  m.running = true; m.lastTick = Date.now(); requestWake();
  save(); paintAll();
}
function doSwap(outId, inId) {
  const m = cur(); if (!m) return;
  flush();
  if (outId && inId) {
    const i = m.onField.indexOf(outId);
    if (i < 0 || m.onField.includes(inId)) return;
    m.onField[i] = inId;
  } else if (inId) {
    if (m.onField.includes(inId)) return;
    m.onField.push(inId);
  } else if (outId) {
    m.onField = m.onField.filter(x => x !== outId);
  }
  m.log.push({ t: Math.round(m.elapsed), out: outId, in: inId });
  m.lastSub = m.elapsed; m.nudged = false;
  sel = null;
  save(); paintAll();
}
function applyPairs(pairs) {
  const m = cur(); if (!m) return;
  flush();
  pairs.forEach(p => {
    if (p.out && p.in) {
      const i = m.onField.indexOf(p.out);
      if (i >= 0 && !m.onField.includes(p.in)) m.onField[i] = p.in;
    } else if (p.in && !m.onField.includes(p.in)) {
      m.onField.push(p.in);
    }
    m.log.push({ t: Math.round(m.elapsed), out: p.out, in: p.in });
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
  S.currentId = null;
  save(true); go('stats');
}

/* ============================== HJELPARAR ============================== */

function beep() {
  try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {}
}
let wake = null;
async function requestWake() {
  try {
    if ('wakeLock' in navigator && !wake) wake = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
function releaseWake() { try { if (wake) { wake.release(); wake = null; } } catch (e) {} }

/* ============================== VISNING ============================== */

let sel = null;          // valgt spiller for manuelt bytte
let lastSig = '';

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
  if (S.tab === 'match') renderMatch();
  else if (S.tab === 'stats') renderStats();
  else if (S.tab === 'setup') renderSetup();
  else renderSquad();
}

/* ------------------------------- KAMP ------------------------------- */

function matchSig(m, pairs) {
  if (!m) return 'none';
  return [
    m.id, m.running, m.period, m.atBreak, m.finished, m.onFieldCount, m.durationSec,
    m.onField.join(','), sel,
    Object.keys(m.lineup).map(id => id + (m.lineup[id].share) + (m.lineup[id].locked ? 'L' : '')).join('|'),
    pairs.map(p => (p.out || '-') + '>' + p.in).join('|'),
    S.countdown, S.squad.length
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
  const done = S.matches.filter(x => x.finished).length;
  return '<header class="topbar"><h1>Kamp</h1></header>' +
    '<div class="card"><div class="empty">Ingen kamp i gang.' +
    (done ? '<br><small>' + done + ' kamp' + (done > 1 ? 'ar' : '') + ' ferdigspilt i denne turneringen.</small>' : '') +
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
  else if (ftime) {
    ctrls = '<button class="btn primary" data-act="end">Avslutt kamp</button>' +
            '<button class="btn ghost" data-act="addtime">+1 min</button>';
  } else if (m.atBreak && m.period < m.periods) {
    ctrls = '<button class="btn primary" data-act="next-period">Start ' + (m.period + 1) + '. omgang</button>';
  } else if (m.running) {
    ctrls = '<button class="btn" data-act="run">⏸ Pause</button>';
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
        '<button class="btn ghost" data-act="menu" style="flex:0 0 56px">⋯</button>' +
      '</div>' +
    '</div>';

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
      '<button class="dots" data-act="pmenu" data-id="' + id + '">⋯</button>' +
    '</div>';
  };

  const notIn = S.squad.filter(p => !L[p.id]);
  const addBtn = notIn.length && !m.finished
    ? '<button class="btn ghost" data-act="addplayer">Legg til spiller i kampen</button>' : '';

  return clock + sugg +
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
  const left = Math.max(0, m.durationSec - m.elapsed);
  c.textContent = S.countdown ? fmt(left) : fmt(m.elapsed);
  c.classList.toggle('paused', !m.running);
  const pEnd = periodEnd(m);
  let sub;
  if (m.finished) sub = 'Kampen er avsluttet';
  else if (m.elapsed >= m.durationSec - 0.5) sub = 'Full tid';
  else if (m.atBreak) sub = 'Pause etter ' + m.period + '. omgang';
  else sub = (S.countdown ? fmt(m.elapsed) + ' spilt' : fmt(left) + ' igjen') +
    (m.periods > 1 ? ' · omgangen slutter ' + fmt(pEnd) : '');
  $('#clocksub').textContent = sub;
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

function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; }

function playerSheet(id) {
  const m = cur(); if (!m) return;
  const L = m.lineup[id] || { share: 1, locked: false };
  const onF = m.onField.includes(id);
  const shares = [1, 0.75, 0.5, 0.25, 0];
  openSheet(
    '<div class="shead"><span class="num2">' + esc(pnum(id)) + '</span>' +
      '<div><b>' + esc(pname(id)) + '</b><small>' + fmt(m.sec[id] || 0) + ' i denne kampen · ' +
      (L.locked ? 'låst' : 'saldo ' + fmtSign(balances()[id] ? balances()[id].bal : 0)) + '</small></div></div>' +
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
    '<div class="sgroup"><span>Rett opp spilletid</span><div class="rowbtns">' +
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
      m.periods + ' omgang' + (m.periods > 1 ? 'ar' : '') + '</small></div></div>' +
    '<div class="sgroup"><span>Kamplengde</span><div class="rowbtns">' +
      '<button class="btn" data-act="mm-dur" data-d="-60">−1 min</button>' +
      '<button class="btn" data-act="mm-dur" data-d="60">+1 min</button>' +
    '</div></div>' +
    '<div class="sgroup"><span>Rett opp klokka</span><div class="rowbtns">' +
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
  const notIn = S.squad.filter(p => !m.lineup[p.id]);
  openSheet('<h2>Legg til i kampen</h2><div class="rows">' +
    (notIn.length ? notIn.map(p =>
      '<div class="srow"><span class="num2" style="width:34px;height:34px;border-radius:10px;background:var(--line);display:flex;align-items:center;justify-content:center;font-weight:800">' +
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
  $('#q-count').textContent = S.squad.length;
  const b = balances();
  $('#squad-list').innerHTML = S.squad.length
    ? S.squad.map(p =>
      '<div class="prow"><span class="num2">' + esc(p.number || '–') + '</span>' +
      '<span class="who"><b>' + esc(p.name) + '</b><small>' + fmt(b[p.id] ? b[p.id].sec : 0) + ' spilt i turneringen</small></span>' +
      '<button class="dots" data-act="sq-menu" data-id="' + p.id + '">⋯</button></div>').join('')
    : '<div class="empty">Ingen spillere enno. Legg dem inn over.</div>';
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
    S.squad.push({ id: uid(), name, number: num });
    n++;
  });
  return n;
}

/* ------------------------------- OPPSETT ------------------------------- */

let setup = null;
function setupInit() {
  const st = S.settings;
  const b = balances();
  setup = {
    name: '',
    duration: st.duration, onField: st.onField, periods: st.periods,
    interval: st.interval, maxSwaps: st.maxSwaps, threshold: st.threshold,
    lineup: {}, start: []
  };
  S.squad.forEach(p => { setup.lineup[p.id] = { share: 1, locked: false }; });
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
  if (!setup.name) $('#s-name').placeholder = 'Kamp ' + (S.matches.length + 1);
  $('#s-duration').value = setup.duration;
  $('#s-onfield').value = setup.onField;
  $('#s-periods').value = setup.periods;
  $('#s-interval').value = setup.interval;
  $('#s-maxswaps').value = setup.maxSwaps;
  $('#s-threshold').value = setup.threshold;

  const b = balances();
  $('#setup-players').innerHTML = S.squad.length ? S.squad.map(p => {
    const l = setup.lineup[p.id] || { share: 1, locked: false };
    return '<div class="srow"><span class="num2" style="flex:none;width:34px;height:34px;border-radius:10px;background:var(--line);display:flex;align-items:center;justify-content:center;font-weight:800">' +
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

  $('#setup-start').innerHTML = S.squad.map(p => {
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
  const num = (sel, def, lo, hi) => {
    const v = parseInt($(sel).value, 10);
    return isNaN(v) ? def : clamp(v, lo, hi);
  };
  setup.duration = num('#s-duration', 50, 1, 120);
  setup.onField = num('#s-onfield', 7, 1, 11);
  setup.periods = num('#s-periods', 2, 1, 4);
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
  S.settings = {
    duration: setup.duration, onField: setup.onField, periods: setup.periods,
    interval: setup.interval, maxSwaps: setup.maxSwaps, threshold: setup.threshold
  };
  const lineup = {};
  Object.keys(setup.lineup).forEach(id => { lineup[id] = { share: setup.lineup[id].share, locked: setup.lineup[id].locked }; });
  const m = newMatch({
    name: setup.name || ('Kamp ' + (S.matches.length + 1)),
    duration: setup.duration, onField: setup.onField, periods: setup.periods,
    interval: setup.interval, maxSwaps: setup.maxSwaps, threshold: setup.threshold,
    lineup, onField0: setup.start
  });
  S.matches.push(m);
  S.currentId = m.id;
  setup = null;
  save(true);
  go('match');
}

/* ------------------------------ STATISTIKK ------------------------------ */

function renderStats() {
  const b = balances();
  const ms = S.matches;
  const anyLock = Object.keys(b).some(id => b[id].lock > 0.5);
  const thr = S.settings.threshold;

  let html = '';
  if (!S.squad.length) {
    html = '<div class="card"><div class="empty">Ingen spillere enno.</div></div>';
  } else {
    const rows = S.squad.slice().sort((x, y) => b[x.id].bal - b[y.id].bal).map(p => {
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
      const on = m.id === S.currentId;
      return '<div class="prow"><span class="num2">' + (i + 1) + '</span>' +
        '<span class="who"><b>' + esc(m.name) + '</b><small>' + fmt(m.elapsed) + ' av ' +
        Math.round(m.durationSec / 60) + ' min' + (on ? ' · i gang' : m.finished ? ' · ferdig' : ' · ikke avsluttet') + '</small></span>' +
        (on ? '<button class="btn sm" data-act="tab" data-tab="match">Åpne</button>'
            : '<button class="btn sm" data-act="reopen" data-id="' + m.id + '">Åpne</button>') +
        '<button class="dots" data-act="del-match" data-id="' + m.id + '">✕</button></div>';
    }).join('') : '<div class="empty">Ingen kamper registrert.</div>') + '</div></div>';

  html += '<div class="card"><h2>Data</h2><div class="rowbtns">' +
    '<button class="btn" data-act="export">Ta backup</button>' +
    '<button class="btn" data-act="import">Les inn backup</button></div>' +
    '<div class="rowbtns"><button class="btn danger" data-act="new-cup">Ny turnering</button>' +
    '<button class="btn danger" data-act="wipe">Slett alt</button></div>' +
    '<p class="hint">«Ny turnering» nullstiller spilletida, men beheld troppen.</p></div>';

  $('#stats-body').innerHTML = html;
}

/* ------------------------------ BACKUP ------------------------------ */

function exportData() {
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
        const p = JSON.parse(r.result);
        if (!p || p.v !== 1 || !Array.isArray(p.squad)) throw new Error('feil format');
        if (!confirm('Erstatte alle data med backupen?')) return;
        S = Object.assign(blank(), p); save(true); go('stats');
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
    case 'addtime': if (m) { m.durationSec += 60; lastSig = ''; save(); paintAll(); } break;
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
      m.sec[id] = Math.max(0, (m.sec[id] || 0) + d);
      save(); lastSig = ''; playerSheet(id); paintAll();
      break;
    }

    /* --- kamp-meny --- */
    case 'mm-dur': {
      if (!m) break;
      flush();
      m.durationSec = clamp(m.durationSec + parseInt(t.dataset.d, 10), 60, 240 * 60);
      save(); lastSig = ''; matchMenuSheet(); paintAll(); break;
    }
    case 'mm-clock': {
      if (!m) break;
      flush();
      m.elapsed = clamp(m.elapsed + parseInt(t.dataset.d, 10), 0, m.durationSec);
      if (m.elapsed < periodEnd(m)) m.atBreak = false;
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
      if (confirm('Slette kampen og all spilletid i han?')) {
        S.matches = S.matches.filter(x => x.id !== m.id);
        S.currentId = null; save(true); closeSheet(); go('stats');
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
      S.squad = S.squad.filter(x => x.id !== id);
      const mm = cur();
      if (mm) { delete mm.lineup[id]; mm.onField = mm.onField.filter(x => x !== id); }
      if (setup) { delete setup.lineup[id]; setup.start = setup.start.filter(x => x !== id); }
      save(true); closeSheet(); paintAll(); break;
    }

    /* --- statistikk --- */
    case 'reopen': {
      if (cur()) { alert('Avslutt den pågående kampen først.'); break; }
      const mm = S.matches.find(x => x.id === id); if (!mm) break;
      mm.finished = false; mm.running = false; mm.lastTick = Date.now();
      S.currentId = id; save(true); go('match'); break;
    }
    case 'del-match': {
      const mm = S.matches.find(x => x.id === id); if (!mm) break;
      if (!confirm('Slette «' + mm.name + '»?')) break;
      S.matches = S.matches.filter(x => x.id !== id);
      if (S.currentId === id) S.currentId = null;
      save(true); paintAll(); break;
    }
    case 'export': exportData(); break;
    case 'import': importData(); break;
    case 'new-cup': {
      if (!confirm('Nullstille all spilletid og starte ny turnering? Troppen blir beholdt.')) break;
      S.matches = []; S.currentId = null; save(true); paintAll(); break;
    }
    case 'wipe': {
      if (!confirm('Slette ALLE data, også troppen?')) break;
      S = blank(); save(true); go('squad'); break;
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
    case 'mm-interval': if (m) { m.interval = clamp(parseInt(t.value, 10) || 5, 1, 30); save(); lastSig = ''; } break;
    case 'mm-maxswaps': if (m) { m.maxSwaps = clamp(parseInt(t.value, 10) || 2, 1, 11); save(); lastSig = ''; } break;
    case 'mm-threshold': if (m) { m.threshold = clamp(parseInt(t.value, 10) || 0, 0, 600); save(); lastSig = ''; } break;
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
function addFromInputs() {
  const nm = $('#q-name').value;
  const num = $('#q-number').value.trim();
  if (!nm.trim()) { $('#q-name').focus(); return; }
  const n = addPlayers(nm, num);
  if (n) {
    $('#q-name').value = ''; $('#q-number').value = '';
    if (setup) S.squad.forEach(p => { if (!setup.lineup[p.id]) setup.lineup[p.id] = { share: 1, locked: false }; });
    save(true); renderSquad(); $('#q-name').focus();
  }
}
$('#q-add').addEventListener('click', addFromInputs);
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
  go(m ? 'match' : (S.squad.length ? 'setup' : 'squad'));

  setInterval(() => {
    const mm = cur();
    if (mm && mm.running) { flush(); save(); }
    if (S.tab === 'match') renderMatch();
  }, 250);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { flush(); paintAll(); requestWake(); }
    else { flush(); save(true); }
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
