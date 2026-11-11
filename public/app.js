// Instructor dashboard client. Renders what the API computes; owns no business logic
// beyond formatting. Filters live in the URL hash so a view can be shared or reloaded.

const POLL_MS = 3000;
const STATE_LABEL = { provisioning: 'Provisioning', ready: 'Ready', in_use: 'In use', failed: 'Failed', deprovisioned: 'Deprovisioned' };
const STATES = Object.keys(STATE_LABEL);
const simulate = new URLSearchParams(location.search).get('simulate');

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dur = (min) => {
  if (min == null) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h ${String(Math.floor(min % 60)).padStart(2, '0')}m`;
};
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const ICON = {
  provisioning: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.4 1.8"/>',
  ready: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  in_use: '<circle cx="6" cy="6" r="5" fill="currentColor"/>',
  failed: '<rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="currentColor"/><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="var(--surface)" stroke-width="1.6"/>',
  deprovisioned: '<path d="M1.5 6h9" stroke="currentColor" stroke-width="1.8"/>',
};
const statusHtml = (s) => `<span class="st" data-s="${s}"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${ICON[s]}</svg>${STATE_LABEL[s]}</span>`;

// ---------- state ----------
const app = {
  filter: readHash(),
  aiSource: null, // { source, explanation, degradedReason, filterKey } of the last NL compile
  rows: [], summary: null, loaded: false,
  prev: new Map(), // id -> "state|step" for change flashes
  rowEls: new Map(),
  selected: null, focusId: null,
  paused: false, failures: 0, lastOkAt: null, timer: null, inflight: false,
  eventsSeq: 0, prevSummary: null,
};

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const f = {};
  for (const [k, v] of p) f[k] = ['states', 'steps', 'pace', 'regions', 'failureCodes'].includes(k) ? v.split(',') : v;
  if (f.steps) f.steps = f.steps.map(Number);
  return f;
}
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(app.filter)) if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) p.set(k, Array.isArray(v) ? v.join(',') : v);
  history.replaceState(null, '', p.toString() ? `#${p}` : location.pathname + location.search);
}
const filterKey = (f) => JSON.stringify(Object.entries(f).filter(([k]) => k !== 'sort' && k !== 'dir').sort());

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(simulate ? { 'x-simulate': simulate } : {}) };
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { status: res.status, body });
  return body;
}

function setFilter(next, { fromAi = false } = {}) {
  app.filter = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  if (!fromAi && app.aiSource && app.aiSource.filterKey !== filterKey(app.filter)) app.aiSource = null;
  writeHash();
  syncControls();
  renderChips();
  refresh();
}

// ---------- data loop ----------
async function refresh() {
  if (app.inflight) { app.queued = true; return; }
  app.inflight = true;
  clearTimeout(app.timer);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(app.filter)) qs.set(k, Array.isArray(v) ? v.join(',') : v);
  try {
    const [list, summary, ev] = await Promise.all([
      api(`/api/environments?${qs}`),
      api('/api/summary'),
      api(`/api/events?since=${app.eventsSeq}`).catch(() => ({ events: [] })),
    ]);
    // Keep the detail panel live even when the selected row is filtered out (e.g. just reprovisioned).
    if (app.selected && !list.rows.some((r) => r.id === app.selected)) {
      app.selectedRow = (await api(`/api/environments?q=${app.selected}`)).rows[0] ?? app.selectedRow;
    }
    app.failures = 0;
    app.lastOkAt = Date.now();
    app.rows = list.rows;
    app.total = list.total;
    app.sortState = { sort: list.filter.sort, dir: list.filter.dir };
    app.prevSummary = app.summary;
    app.summary = summary;
    app.loaded = true;
    renderAll();
    renderFeed(ev.events);
    hideBanner();
  } catch (err) {
    app.failures++;
    app.lastError = err;
    renderError(err);
  } finally {
    app.inflight = false;
    schedule();
    if (app.queued) { app.queued = false; refresh(); }
  }
}

function schedule() {
  clearTimeout(app.timer);
  if (app.paused) return renderLive();
  // Back off on repeated failures: 3s, 6s, 12s … capped at 30s.
  const wait = app.failures ? Math.min(30_000, POLL_MS * 2 ** (app.failures - 1)) : POLL_MS;
  app.nextAt = Date.now() + wait;
  app.timer = setTimeout(refresh, wait);
  renderLive();
}

// ---------- rendering ----------
function renderAll() {
  renderHeader();
  renderLedger();
  renderStateBar();
  renderFunnel();
  renderRows();
  renderDetail();
  renderLive();
}

function renderHeader() {
  const s = app.summary.session;
  $('#session-title').textContent = s.title;
  document.title = `${app.summary.failures ? `(${app.summary.failures} failed) ` : ''}Workshop Ops · CloudLabs`;
  app.sessionClock = { startedAt: s.startedAt, plannedEndAt: s.plannedEndAt, skew: Date.now() - s.now };
  tickClock();
}
function tickClock() {
  const c = app.sessionClock;
  if (!c) return;
  const now = Date.now() - c.skew;
  const el = (now - c.startedAt) / 60000, total = (c.plannedEndAt - c.startedAt) / 60000;
  $('#clock').textContent = `${dur(el)} of ${dur(total)} elapsed`;
}

function renderLive() {
  const live = $('#live'), text = $('#live-text');
  if (app.paused) { live.dataset.state = 'paused'; text.textContent = 'Paused'; return; }
  if (app.failures) {
    live.dataset.state = 'stale';
    const secs = Math.max(0, Math.round((app.nextAt - Date.now()) / 1000));
    text.textContent = `Offline · retry in ${secs}s`;
    return;
  }
  if (!app.loaded) { live.dataset.state = ''; text.textContent = 'Loading…'; return; }
  live.dataset.state = 'ok';
  const ago = app.lastOkAt ? Math.round((Date.now() - app.lastOkAt) / 1000) : 0;
  text.textContent = `Live · updated ${ago < 2 ? 'just now' : `${ago}s ago`}`;
}

function metric({ label, big, sub, cls = '', action, key }) {
  // Flash only discrete status counts; spend ticks every poll and would flash constantly.
  const changed = ['active', 'failed', 'help'].includes(key) && app.prevMetric?.[key] !== undefined && app.prevMetric[key] !== big;
  app.nextMetric[key] = big;
  const inner = `<span class="m-label">${label}</span><span class="big${changed ? ' changed' : ''}">${big}</span><span class="sub">${sub}</span>`;
  return action
    ? `<button class="metric ${cls}" data-act="${action}" title="Filter the table">${inner}</button>`
    : `<div class="metric ${cls}">${inner}</div>`;
}

function renderLedger() {
  const s = app.summary;
  const codes = Object.entries(s.failureCodes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ') || 'none';
  const help = s.pace.slow + s.pace.stuck;
  const hot = [...s.funnel].sort((a, b) => b.stuck - a.stuck)[0];
  app.nextMetric = {};
  $('#ledger').innerHTML = [
    metric({ key: 'active', label: 'Active environments', big: `${s.active}<small> / ${s.total}</small>`, sub: `${s.byState.in_use} in use · ${s.byState.ready} ready, not started · ${s.byState.provisioning} provisioning` }),
    metric({ key: 'failed', label: 'Failed', big: `${s.failures}`, cls: s.failures ? 'alert' : '', action: 'failed', sub: s.failures ? `${codes}` : 'No failed environments' }),
    metric({ key: 'help', label: 'Need help (stuck / slow)', big: `${s.pace.stuck}<small> / ${s.pace.slow}</small>`, cls: help ? 'warn' : '', action: 'help', sub: hot?.stuck ? `Most stuck on step ${hot.step}: ${esc(hot.title)}` : 'Everyone within expected time' }),
    metric({ key: 'spend', label: 'Estimated spend', big: money(s.spend.total), sub: `${money(s.spend.burnPerHour)}/h now · ${money(s.spend.projectedAtEnd)} projected · ${money(s.spend.idleBurnPerHour)}/h idle` }),
    metric({ key: 'done', label: 'Average completion', big: `${s.completion.averagePct.toFixed(1)}%`, sub: `${s.completion.completed} finished · median ${dur(s.completion.medianMinutesToComplete)} to finish` }),
  ].join('');
  app.prevMetric = app.nextMetric;
  $('#ledger').setAttribute('aria-busy', 'false');
}

function renderStateBar() {
  const s = app.summary, sel = app.filter.states ?? [];
  $('#statebar').innerHTML = STATES.map((st) => `<button class="seg" data-s="${st}" style="flex-grow:${s.byState[st]}" aria-pressed="${sel.includes(st)}" aria-label="${STATE_LABEL[st]}: ${s.byState[st]}" tabindex="-1"></button>`).join('');
  let legend = $('#statelegend');
  if (!legend) { legend = document.createElement('div'); legend.id = 'statelegend'; legend.className = 'statelegend'; $('#statebar').after(legend); }
  legend.innerHTML = STATES.map((st) => `<button data-state="${st}" aria-pressed="${sel.includes(st)}">${statusHtml(st)}<b>${s.byState[st]}</b></button>`).join('');
}

function renderFunnel() {
  const f = app.summary.funnel, max = Math.max(1, ...f.map((b) => b.active));
  const sel = app.filter.steps ?? [];
  $('#funnel').innerHTML = f.map((b) => {
    const h = (n) => `${(n / max) * 52}px`;
    const ok = b.active - b.slow - b.stuck;
    return `<button class="fstep" data-step="${b.step}" aria-pressed="${sel.includes(b.step)}"
      aria-label="Step ${b.step}, ${esc(b.title)}: ${b.active} learners, ${b.stuck} stuck, ${b.slow} slow. Median ${dur(b.medianMin)} on step, expected ${b.expectedMin} minutes"
      title="${esc(b.title)} · expected ~${b.expectedMin}m · median ${dur(b.medianMin)}">
      <span class="fbar" aria-hidden="true"><i style="height:${h(ok)}"></i><i class="f-slow" style="height:${h(b.slow)}"></i><i class="f-stuck" style="height:${h(b.stuck)}"></i></span>
      <span class="fnum"><b>${b.active}</b>${b.stuck ? `<span class="st">${b.stuck} stuck</span>` : ''}</span>
      <span class="flabel">${b.step} · ${esc(b.title)}</span>
    </button>`;
  }).join('');
}

function rowHtml(r) {
  const failed = r.state === 'failed';
  const pips = Array.from({ length: 8 }, (_, i) => {
    const n = i + 1;
    if (n <= r.stepsDone) return '<i class="d"></i>';
    if (n === r.step && r.state === 'in_use') return `<i class="c ${r.pace}"></i>`;
    return '<i></i>';
  }).join('');
  let stepCell, timeCell;
  if (failed) {
    stepCell = `<span class="err-code">${esc(r.failure.code)}</span><span class="err-msg">${esc(r.failure.message)}</span>`;
    timeCell = `<span class="time"><b>${dur(r.minutesInState)}</b><span class="of">down</span></span>`;
  } else if (r.completed) {
    stepCell = '<span class="muted">All steps complete</span>';
    timeCell = '<span class="muted">—</span>';
  } else if (r.state === 'in_use') {
    stepCell = `<span class="n">${r.step}</span>${esc(r.stepTitle)}`;
    const tag = r.pace === 'stuck' ? '<span class="tag stuck">STUCK</span>' : r.pace === 'slow' ? '<span class="tag slow">SLOW</span>' : '';
    timeCell = `<span class="time ${r.pace}">${tag}<b>${dur(r.minutesOnStep)}</b><span class="of">/${r.stepExpectedMin}m</span></span>`;
  } else if (r.state === 'provisioning') {
    stepCell = `<span class="muted">Provisioning${r.attempts > 1 ? ` · attempt ${r.attempts}` : ''}</span>`;
    timeCell = `<span class="time ${r.pace}">${r.pace === 'slow' ? '<span class="tag slow">SLOW</span>' : ''}<b>${dur(r.minutesInState)}</b></span>`;
  } else if (r.state === 'ready') {
    stepCell = `<span class="muted">Ready, learner not connected · resumes step ${r.step}</span>`;
    timeCell = `<span class="time"><b>${dur(r.minutesInState)}</b><span class="of">idle</span></span>`;
  } else {
    stepCell = `<span class="muted">${r.stepsDone === 8 ? 'Finished, torn down' : `Torn down at step ${r.step}`}</span>`;
    timeCell = '<span class="muted">—</span>';
  }
  const action = failed
    ? `<button class="btn danger" data-reprovision="${r.id}" aria-label="Reprovision ${esc(r.id)} for ${esc(r.learner)}">Reprovision</button>`
    : r.attempts > 1 && r.state !== 'deprovisioned' ? `<span class="muted small">attempt ${r.attempts}</span>` : '';
  return `<td>${statusHtml(r.state)}</td>
    <td class="learner">${esc(r.learner)}<small>${r.region}</small></td>
    <td class="mono">${r.id}</td>
    <td><span class="prog"><span class="pips" aria-hidden="true">${pips}</span><span class="frac tnum">${r.stepsDone}/8</span></span></td>
    <td class="stepcell">${stepCell}</td>
    <td class="num">${timeCell}</td>
    <td class="num">${money(r.spend)}</td>
    <td>${action}</td>`;
}

function renderRows() {
  const tbody = $('#rows'), panel = $('#state-panel');
  if (!app.rows.length) {
    tbody.replaceChildren();
    app.rowEls.clear();
    const active = Object.keys(app.filter).some((k) => k !== 'sort' && k !== 'dir');
    panel.hidden = false;
    panel.className = 'state-panel';
    panel.innerHTML = app.total === 0
      ? '<h3>No environments in this session yet</h3><p>Environments appear here as soon as the lab orchestrator starts provisioning them.</p>'
      : active
        ? `<h3>No environments match these filters</h3><p>${app.total} environments exist; none match right now. The view keeps updating.</p><button class="btn" data-act="clear">Clear filters</button>`
        : '<h3>No environments</h3>';
    $('#foot').textContent = '';
    return;
  }
  panel.hidden = true;
  const focused = document.activeElement?.closest?.('#rows tr')?.dataset.id;
  const seen = new Set();
  const order = app.rows.map((r) => {
    seen.add(r.id);
    let tr = app.rowEls.get(r.id);
    const sig = `${r.state}|${r.step}|${r.completed}`;
    const html = rowHtml(r);
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.id = r.id;
      tr.tabIndex = -1;
      app.rowEls.set(r.id, tr);
    }
    if (tr._html !== html) { tr.innerHTML = html; tr._html = html; }
    tr.className = `is-${r.state}`;
    tr.setAttribute('aria-selected', String(app.selected === r.id));
    const before = app.prev.get(r.id);
    if (before && before !== sig) { tr.classList.remove('changed'); void tr.offsetWidth; tr.classList.add('changed'); }
    app.prev.set(r.id, sig);
    return tr;
  });
  for (const [id, tr] of app.rowEls) if (!seen.has(id)) { tr.remove(); app.rowEls.delete(id); }
  tbody.replaceChildren(...order);
  const fid = app.focusId ?? order[0]?.dataset.id;
  for (const tr of order) tr.tabIndex = tr.dataset.id === fid ? 0 : -1;
  if (!order.some((tr) => tr.tabIndex === 0) && order[0]) order[0].tabIndex = 0;
  if (focused && app.rowEls.get(focused)) app.rowEls.get(focused).focus({ preventScroll: true });

  // Sort indicator from what the server actually applied.
  for (const th of document.querySelectorAll('.grid thead th')) {
    const b = th.querySelector('.sort');
    if (b && b.dataset.sort === app.sortState.sort) th.setAttribute('aria-sort', app.sortState.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
  const failedHidden = app.summary.failures - app.rows.filter((r) => r.state === 'failed').length;
  $('#foot').textContent = `Showing ${app.rows.length} of ${app.total} environments${failedHidden > 0 ? ` · ${failedHidden} failed environment${failedHidden > 1 ? 's' : ''} hidden by filters` : ''} · sorted by ${app.sortState.sort === 'attention' ? 'triage (failed → stuck → slow)' : app.sortState.sort}`;
}

function renderSkeleton() {
  $('#rows').innerHTML = Array.from({ length: 14 }, (_, i) => `<tr class="skel" aria-hidden="true">${Array.from({ length: 8 }, (_, j) => `<td><span style="width:${40 + ((i * 7 + j * 13) % 50)}%"></span></td>`).join('')}</tr>`).join('');
  $('#ledger').innerHTML = Array.from({ length: 5 }, () => '<div class="metric"><span class="m-label">&nbsp;</span><span class="big" style="display:block;height:28px;width:60%;background:var(--sunk)"></span></div>').join('');
}

function renderError(err) {
  if (!app.loaded) {
    // Nothing to show yet: full error state with a manual retry.
    $('#rows').replaceChildren();
    const panel = $('#state-panel');
    panel.hidden = false;
    panel.className = 'state-panel error';
    panel.innerHTML = `<h3>Can't reach the workshop API</h3><p>${esc(err.message)}${err.status ? ` (HTTP ${err.status})` : ''}. Retrying automatically with backoff.</p><button class="btn" data-act="retry">Retry now</button>`;
    $('#ledger').innerHTML = '<div class="metric"><span class="m-label">Summary unavailable</span><span class="sub">Waiting for the API</span></div>';
    return;
  }
  // We have data: keep it on screen, but say plainly how old it is.
  const ago = Math.round((Date.now() - app.lastOkAt) / 1000);
  showBanner(`Connection lost: ${esc(err.message)}. Showing data from ${hhmm(app.lastOkAt)} (${ago}s old). <button class="btn" data-act="retry">Retry now</button>`);
}

function showBanner(html) { const b = $('#banner'); b.innerHTML = html; b.hidden = false; }
function hideBanner() { $('#banner').hidden = true; }

function renderChips() {
  const f = app.filter, chips = [];
  const add = (key, label) => chips.push(`<span class="chip">${label}<button data-unset="${key}" aria-label="Remove filter: ${esc(label.replace(/<[^>]+>/g, ''))}">×</button></span>`);
  if (f.states) add('states', `State: ${f.states.map((s) => STATE_LABEL[s] ?? s).join(', ')}`);
  if (f.steps) add('steps', `Step ${f.steps.join(', ')}`);
  if (f.minOnStepMin != null) add('minOnStepMin', `≥ ${f.minOnStepMin}m on step / in state`);
  if (f.maxOnStepMin != null) add('maxOnStepMin', `≤ ${f.maxOnStepMin}m on step / in state`);
  if (f.pace) add('pace', `Pace: ${f.pace.join(', ')}`);
  if (f.regions) add('regions', `Region: ${f.regions.join(', ')}`);
  if (f.failureCodes) add('failureCodes', `Error: ${f.failureCodes.join(', ')}`);
  if (f.minSpend != null) add('minSpend', `Spend ≥ ${money(Number(f.minSpend))}`);
  if (f.q) add('q', `Search: “${esc(f.q)}”`);
  const src = app.aiSource
    ? `<span class="chip-src">from “${esc(app.aiSource.text)}” · ${app.aiSource.source === 'model' ? 'compiled by Claude' : 'compiled by keyword rules'}</span>`
    : '';
  $('#chips').innerHTML = chips.length ? `${chips.join('')} ${src} <button class="linkbtn" data-act="clear">Clear all</button>` : '<span class="muted">No filters · all environments, triage order</span>';
}

function syncControls() {
  const f = app.filter;
  $('#q').value = f.q ?? '';
  $('#pace').value = f.pace ? f.pace.join(',') : '';
  if ($('#pace').value !== (f.pace ? f.pace.join(',') : '')) $('#pace').value = '';
  $('#step').value = f.steps?.length === 1 ? String(f.steps[0]) : '';
  $('#region').value = f.regions?.length === 1 ? f.regions[0] : '';
}

function renderDetail() {
  const box = $('#detail');
  const r = app.selected && (app.rows.find((x) => x.id === app.selected) ?? app.selectedRow);
  if (!r) {
    box.innerHTML = '<h2 class="eyebrow">Selected</h2><p class="muted small">Select a row (click or Enter) to see its step timeline.</p>';
    return;
  }
  app.selectedRow = r;
  const steps = app.summary.session.steps;
  const tl = steps.map((s) => {
    const n = s.n;
    if (n <= r.stepsDone) {
      const m = r.stepHistoryMin[n - 1];
      return `<li><span>✓</span><span>${n}. ${esc(s.title)}</span><span class="tnum ${m > s.expectedMin * 1.5 ? 'over' : ''}">${dur(m)} <span class="muted">/ ${s.expectedMin}m</span></span></li>`;
    }
    if (n === r.step && r.state === 'in_use') return `<li class="cur"><span>→</span><span>${n}. ${esc(s.title)}</span><span class="tnum ${r.pace !== 'ok' ? 'over' : ''}">${dur(r.minutesOnStep)} <span class="muted">/ ${s.expectedMin}m</span></span></li>`;
    return `<li class="todo"><span>·</span><span>${n}. ${esc(s.title)}</span><span>${s.expectedMin}m</span></li>`;
  }).join('');
  box.innerHTML = `<h2 class="eyebrow">Selected</h2>
    <h3>${esc(r.learner)}</h3>
    <p class="meta"><span class="mono">${r.id}</span> · ${r.region} · ${r.sku}</p>
    ${r.state === 'failed' ? `<div class="failbox"><b>${esc(r.failure.code)}</b> · down ${dur(r.minutesInState)}<br>${esc(r.failure.message)}<div style="margin-top:8px"><button class="btn danger" data-reprovision="${r.id}">Reprovision environment</button></div></div>` : ''}
    <dl class="kv">
      <dt>State</dt><dd>${statusHtml(r.state)} · ${dur(r.minutesInState)}</dd>
      <dt>Progress</dt><dd class="tnum">${r.stepsDone} of 8 steps</dd>
      <dt>Rate</dt><dd class="tnum">${money(r.ratePerHour)}/h</dd>
      <dt>Spend so far</dt><dd class="tnum">${money(r.spend)}</dd>
      <dt>Provision attempts</dt><dd class="tnum">${r.attempts}</dd>
    </dl>
    <h2 class="eyebrow">Step timeline <span class="muted">actual / expected</span></h2>
    <ol class="timeline">${tl}</ol>`;
}

function renderFeed(events) {
  if (!events.length) return;
  app.eventsSeq = events.at(-1).seq;
  const list = $('#feed');
  const first = list.children.length === 0;
  const html = events.slice().reverse().map((e) => `<li data-k="${e.kind}" class="${first ? '' : 'new'}"><time datetime="${new Date(e.at).toISOString()}">${hhmm(e.at).slice(0, 5)}</time><span><span class="who">${esc(e.learner)}</span> <span class="mono muted">${e.envId}</span><br><span class="what">${esc(e.text)}</span></span></li>`).join('');
  list.insertAdjacentHTML('afterbegin', html);
  while (list.children.length > 60) list.lastElementChild.remove();
  $('#feed-count').textContent = `· last ${list.children.length}`;
}

// ---------- actions ----------
async function doReprovision(ids, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
  try {
    const res = await api('/api/environments/reprovision', { method: 'POST', body: JSON.stringify({ ids }) });
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length) showBanner(`${res.reprovisioned} reprovisioned; ${failed.length} skipped (${esc(failed[0].error)}).`);
  } catch (err) {
    showBanner(`Reprovision failed: ${esc(err.body?.results?.[0]?.error ?? err.message)}. Nothing was changed.`);
  } finally {
    await refresh();
  }
}

async function askCompile(text) {
  const status = $('#ask-status'), go = $('#ask-go');
  status.className = 'ask-status';
  status.textContent = 'Compiling…';
  go.disabled = true;
  try {
    const res = await api('/api/nl-filter', { method: 'POST', body: JSON.stringify({ text }) });
    const kept = { ...(app.filter.sort ? { sort: app.filter.sort, dir: app.filter.dir } : {}), ...res.filter };
    app.aiSource = { ...res, text, filterKey: filterKey(kept) };
    if (res.source === 'model') {
      status.textContent = `${res.explanation}${res.unsupported ? ` · ignored: ${res.unsupported}` : ''}`;
    } else {
      status.className = 'ask-status degraded';
      status.textContent = `${res.degradedReason}: used keyword rules. ${res.explanation}`;
    }
    status.title = status.textContent;
    setFilter(kept, { fromAi: true });
  } catch (err) {
    // The NL path is optional; a failure here never touches the current view.
    status.className = 'ask-status degraded';
    status.textContent = `Couldn't compile (${err.message}). Filters below still work.`;
  } finally {
    go.disabled = false;
  }
}

function toggleIn(list = [], v) { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]; }

// ---------- events ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, tr');
  if (!t) return;
  if (t.dataset.reprovision) return doReprovision([t.dataset.reprovision], t);
  if (t.dataset.unset) { const f = { ...app.filter }; delete f[t.dataset.unset]; return setFilter(f); }
  if (t.dataset.state || (t.classList.contains('seg') && t.dataset.s)) {
    return setFilter({ ...app.filter, states: toggleIn(app.filter.states, t.dataset.state ?? t.dataset.s) });
  }
  if (t.dataset.step) {
    const n = Number(t.dataset.step);
    return setFilter({ ...app.filter, steps: app.filter.steps?.length === 1 && app.filter.steps[0] === n ? undefined : [n] });
  }
  if (t.dataset.sort) {
    const same = app.sortState?.sort === t.dataset.sort;
    const dir = same ? (app.sortState.dir === 'asc' ? 'desc' : 'asc') : undefined;
    return setFilter({ ...app.filter, sort: t.dataset.sort, dir });
  }
  const act = t.dataset.act;
  if (act === 'clear') return clearFilters();
  if (act === 'retry') { app.failures = 0; return refresh(); }
  if (act === 'failed') return setFilter({ ...app.filter, states: ['failed'], pace: undefined });
  if (act === 'help') return setFilter({ ...app.filter, pace: ['slow', 'stuck'], states: undefined });
  if (t.tagName === 'TR' && t.dataset.id) selectRow(t.dataset.id);
});

function selectRow(id) {
  app.selected = app.selected === id ? null : id;
  app.focusId = id;
  for (const [rid, tr] of app.rowEls) tr.setAttribute('aria-selected', String(rid === app.selected));
  renderDetail();
}

function clearFilters() {
  app.aiSource = null;
  $('#ask').value = '';
  $('#ask-status').textContent = '';
  setFilter(app.filter.sort ? { sort: app.filter.sort, dir: app.filter.dir } : {});
}

$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#ask').value.trim();
  if (text) askCompile(text);
});
let qTimer;
$('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => setFilter({ ...app.filter, q: e.target.value.trim() || undefined }), 200); });
$('#pace').addEventListener('change', (e) => setFilter({ ...app.filter, pace: e.target.value ? e.target.value.split(',') : undefined }));
$('#step').addEventListener('change', (e) => setFilter({ ...app.filter, steps: e.target.value ? [Number(e.target.value)] : undefined }));
$('#region').addEventListener('change', (e) => setFilter({ ...app.filter, regions: e.target.value ? [e.target.value] : undefined }));
$('#pause').addEventListener('click', togglePause);
$('#help-btn').addEventListener('click', () => $('#help').showModal());
$('#bulk').addEventListener('click', async (e) => {
  const n = app.summary?.failures ?? 0;
  if (!n || !confirm(`Reprovision all ${n} failed environments? Each one starts billing again while it provisions.`)) return;
  const list = await api('/api/environments?states=failed').catch(() => null);
  if (list) doReprovision(list.rows.map((r) => r.id), e.currentTarget);
});

function togglePause() {
  app.paused = !app.paused;
  $('#pause').textContent = app.paused ? 'Resume' : 'Pause';
  $('#pause').setAttribute('aria-pressed', String(app.paused));
  app.paused ? schedule() : refresh();
}

document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('input, select, textarea');
  if (e.key === 'Escape') {
    if (typing) { e.target.blur(); return; }
    if (app.selected) { app.selected = null; renderDetail(); renderRows(); return; }
    return clearFilters();
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = [...$('#rows').children].filter((r) => r.dataset.id);
  const cur = document.activeElement?.closest?.('#rows tr');
  const idx = cur ? rows.indexOf(cur) : -1;
  const move = (d) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, idx + d))];
    if (!next) return;
    for (const r of rows) r.tabIndex = -1;
    next.tabIndex = 0;
    app.focusId = next.dataset.id;
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  };
  switch (e.key) {
    case 'j': case 'ArrowDown': if (cur || e.key === 'j') { e.preventDefault(); move(idx < 0 ? 0 : 1); } break;
    case 'k': case 'ArrowUp': if (cur || e.key === 'k') { e.preventDefault(); move(idx < 0 ? 0 : -1); } break;
    case 'Enter': if (cur && e.target === cur) { e.preventDefault(); selectRow(cur.dataset.id); } break;
    case 'r': case 'R': {
      const btn = cur?.querySelector('[data-reprovision]');
      if (btn) { e.preventDefault(); doReprovision([btn.dataset.reprovision], btn); }
      break;
    }
    case '/': e.preventDefault(); $('#q').focus(); break;
    case 'a': e.preventDefault(); $('#ask').focus(); break;
    case 'f': setFilter({ ...app.filter, states: app.filter.states?.join() === 'failed' ? undefined : ['failed'] }); break;
    case 's': setFilter({ ...app.filter, pace: app.filter.pace?.join() === 'slow,stuck' ? undefined : ['slow', 'stuck'] }); break;
    case 'p': togglePause(); break;
    case '?': $('#help').showModal(); break;
  }
});

window.addEventListener('hashchange', () => { app.filter = readHash(); syncControls(); renderChips(); refresh(); });
setInterval(() => { tickClock(); renderLive(); if (app.summary) updateBulk(); }, 1000);
function updateBulk() {
  const n = app.summary.failures, b = $('#bulk');
  b.hidden = n < 2;
  if (!b.disabled) b.textContent = `Reprovision all failed (${n})`;
  if (b.disabled && b.textContent === 'Requesting…' && !app.inflight) b.disabled = false;
}

// ---------- boot ----------
(async function boot() {
  renderSkeleton();
  renderChips();
  syncControls();
  try {
    const s = await api('/api/summary');
    $('#step').insertAdjacentHTML('beforeend', s.session.steps.map((x) => `<option value="${x.n}">${x.n} · ${esc(x.title)}</option>`).join(''));
    syncControls();
  } catch { /* refresh() below will render the error state */ }
  for (const r of ['eastus', 'westeurope', 'southeastasia', 'centralindia']) $('#region').insertAdjacentHTML('beforeend', `<option>${r}</option>`);
  syncControls();
  api('/api/ai').then((ai) => {
    $('#ask').title = ai.configured ? `Compiled by ${ai.model}; falls back to keyword rules if the model is unavailable` : 'No model key configured: compiled by local keyword rules';
  }).catch(() => {});
  refresh();
})();
