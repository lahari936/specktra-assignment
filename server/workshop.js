// Workshop model: seeded dataset, server-side drift, queries, aggregations, mutations.
// Everything the dashboard shows is computed here so the UI never does business math.

export const STATES = ['provisioning', 'ready', 'in_use', 'failed', 'deprovisioned'];
// Azure keeps charging while resources are allocated, including a failed-but-not-deleted deployment.
const BILLABLE = new Set(['provisioning', 'ready', 'in_use', 'failed']);

export const STEPS = [
  { n: 1, title: 'Verify subscription & RBAC', expectedMin: 6 },
  { n: 2, title: 'Deploy hub VNet', expectedMin: 12 },
  { n: 3, title: 'Configure Azure Firewall', expectedMin: 20 },
  { n: 4, title: 'Peer spoke VNets', expectedMin: 14 },
  { n: 5, title: 'Route tables & UDRs', expectedMin: 16 },
  { n: 6, title: 'Deploy workload VM', expectedMin: 14 },
  { n: 7, title: 'NSG rules & Bastion', expectedMin: 12 },
  { n: 8, title: 'Validate traffic flow', expectedMin: 10 },
];
const TOTAL_STEPS = STEPS.length;

export const SKUS = {
  'lab-small': { label: 'B2s + Firewall Basic', ratePerHour: 0.94 },
  'lab-standard': { label: 'D2s v5 + Firewall Basic', ratePerHour: 1.18 },
  'lab-large': { label: 'D4s v5 + Firewall Std', ratePerHour: 1.86 },
};
export const REGIONS = ['eastus', 'westeurope', 'southeastasia', 'centralindia'];

export const FAILURES = {
  QuotaExceeded: 'Regional vCPU quota exceeded for subscription',
  AllocationFailed: 'Requested VM size unavailable in the selected zone',
  DeploymentTimeout: 'ARM deployment did not finish within 20 minutes',
  PolicyDenied: "Azure Policy 'Allowed locations' denied a resource",
  VMUnresponsive: 'Workload VM stopped responding to health probe',
};

// Pace thresholds relative to the step's expected duration.
const SLOW_X = 1.5;
const STUCK_X = 2;
const PROVISION_SLOW_MIN = 8;

const MIN = 60_000;
const SESSION_LENGTH_MIN = 180;

// ---------- seeded RNG (data is reproducible; drift is not) ----------
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Aarav', 'Maya', 'Liam', 'Priya', 'Noah', 'Sofia', 'Ethan', 'Ananya', 'Lucas', 'Zara', 'Mateo', 'Isha', 'Leo', 'Chloe', 'Arjun', 'Emma', 'Kenji', 'Fatima', 'Owen', 'Nina', 'Ravi', 'Hana', 'Diego', 'Amara', 'Felix', 'Leila', 'Omar', 'Yuki', 'Tomas', 'Grace'];
const LAST = ['Sharma', 'Chen', 'Okafor', 'Rossi', 'Patel', 'Nguyen', 'Müller', 'Silva', 'Kim', 'Haddad', 'Reddy', 'Novak', 'Tanaka', 'Garcia', 'Iyer', 'Brown', 'Kowalski', 'Mensah', 'Larsen', 'Das'];

export function createWorkshop({ seed = 42, count = 120, now = Date.now() } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const startedAt = now - 72 * MIN;
  const envs = [];
  const used = new Set();

  for (let i = 0; i < count; i++) {
    let name;
    do name = `${pick(FIRST)} ${pick(LAST)}`; while (used.has(name));
    used.add(name);
    const skuKey = rand() < 0.55 ? 'lab-standard' : rand() < 0.7 ? 'lab-small' : 'lab-large';
    const env = {
      id: `lab-${String(i + 1).padStart(3, '0')}`,
      learner: name,
      region: REGIONS[Math.floor(rand() * rand() * REGIONS.length)], // skewed toward eastus
      sku: skuKey,
      ratePerHour: SKUS[skuKey].ratePerHour,
      state: 'in_use',
      stateSince: 0,
      step: 1,
      stepStartedAt: 0,
      stepDurations: [], // ms spent on each completed step
      completedAt: null,
      failure: null,
      attempts: 1,
      billedMs: 0,
      failedBilledMs: 0,
      billingSince: null,
      // Hidden per-learner pace multiplier drives drift; never sent to the client.
      _pace: rand() < 0.12 ? 2.6 + rand() : 0.75 + rand() * 0.75,
    };

    // Distribute an initial snapshot ~95 minutes into the session.
    const r = rand();
    const provisionedAt = startedAt + rand() * 6 * MIN;
    if (r < 0.05) {
      setState(env, 'provisioning', now - rand() * 11 * MIN, true);
      env.attempts = rand() < 0.4 ? 2 : 1;
    } else if (r < 0.13) {
      setState(env, 'ready', now - rand() * 25 * MIN, true, provisionedAt);
    } else if (r < 0.18) {
      const failAt = now - (4 + rand() * 30) * MIN;
      fastForward(env, provisionedAt, failAt, rand);
      env.billedMs = failAt - provisionedAt; // healthy runtime before the failure
      env.billingSince = null;
      setState(env, 'failed', failAt, true); // idle-but-billing from here on
      const code = pick(Object.keys(FAILURES));
      env.failure = { code, message: FAILURES[code] };
    } else if (r < 0.28) {
      // Finished learners who already tore down, plus a couple who abandoned.
      const done = rand() < 0.75;
      if (done) env._pace = 0.5 + rand() * 0.15; // only the quickest have finished this early
      const end = now - rand() * 20 * MIN;
      fastForward(env, provisionedAt, end, rand, done);
      setState(env, 'deprovisioned', end, true);
    } else {
      fastForward(env, provisionedAt, now, rand);
      // A realistic workshop has a tail of learners sitting well past the expected time.
      if (!env.completedAt && rand() < 0.2) {
        const back = STEPS[env.step - 1].expectedMin * MIN * (1.3 + rand() * 1.9);
        env.stepStartedAt = Math.max(provisionedAt + 3 * MIN, now - back);
      }
      setState(env, 'in_use', provisionedAt + 3 * MIN, true, provisionedAt);
    }
    envs.push(env);
  }

  const ws = {
    session: {
      id: 'ws-az104-1111',
      title: 'AZ-104 Lab: Secure hub-spoke networking',
      instructor: 'Instructor console',
      startedAt,
      plannedEndAt: startedAt + SESSION_LENGTH_MIN * MIN,
      steps: STEPS,
    },
    envs,
    events: [],
    version: 0,
  };
  // Backfill the activity log with what already happened so the feed isn't blank on boot.
  const past = envs.flatMap((e) => e.state === 'failed'
    ? [[e.stateSince, e, 'failed', `Failed on step ${e.step}: ${e.failure.code}`]]
    : e.completedAt ? [[e.completedAt, e, 'completed', 'Completed all steps']] : []);
  for (const [at, e, kind, text] of past.sort((a, b) => a[0] - b[0])) log(ws, at, e, kind, text);
  return ws;
}

// Walks a learner through steps from `from` to `to` using their pace, leaving the
// remainder as time on the current step. Billing is accumulated to `to`.
function fastForward(env, from, to, rand, finishAll = false) {
  let t = from + 3 * MIN;
  env.step = 1;
  env.stepDurations = [];
  while (env.step <= TOTAL_STEPS) {
    const dur = STEPS[env.step - 1].expectedMin * MIN * env._pace * (0.6 + rand() * 0.8);
    if (!finishAll && t + dur > to) break;
    env.stepDurations.push(dur);
    t += dur;
    env.step++;
  }
  if (env.step > TOTAL_STEPS) {
    env.step = TOTAL_STEPS;
    env.completedAt = Math.min(t, to);
  }
  env.stepStartedAt = env.completedAt ?? t;
  env.billingSince = from;
}

function setState(env, state, at, seeding = false, billingFrom = at) {
  if (seeding) {
    env.state = state;
    env.stateSince = at;
    if (BILLABLE.has(state)) env.billingSince ??= billingFrom;
    else if (env.billingSince != null) {
      env.billedMs += at - env.billingSince;
      env.billingSince = null;
    }
    return;
  }
  closeBilling(env, at);
  env.state = state;
  env.stateSince = at;
  if (BILLABLE.has(state)) env.billingSince = at;
}

function closeBilling(env, at) {
  if (env.billingSince == null) return;
  const seg = at - env.billingSince;
  env.billedMs += seg;
  if (env.state === 'failed') env.failedBilledMs += seg;
  env.billingSince = null;
}

// ---------- derived fields ----------
export function spendOf(env, now) {
  const live = env.billingSince != null ? now - env.billingSince : 0;
  return (env.ratePerHour * (env.billedMs + live)) / 3_600_000;
}

function idleFailedSpend(env, now) {
  const live = env.state === 'failed' && env.billingSince != null ? now - env.billingSince : 0;
  return (env.ratePerHour * (env.failedBilledMs + live)) / 3_600_000;
}

export function paceOf(env, now) {
  if (env.state === 'provisioning') return now - env.stateSince > PROVISION_SLOW_MIN * MIN ? 'slow' : 'ok';
  if (env.state !== 'in_use' || env.completedAt) return 'ok';
  const ratio = (now - env.stepStartedAt) / (STEPS[env.step - 1].expectedMin * MIN);
  return ratio >= STUCK_X ? 'stuck' : ratio >= SLOW_X ? 'slow' : 'ok';
}

function attentionScore(row) {
  // Higher = needs the instructor sooner. Failed > stuck > slow provisioning > slow > rest.
  if (row.state === 'failed') return 4000 + row.minutesInState;
  if (row.pace === 'stuck') return 3000 + row.stepRatio * 100;
  if (row.state === 'provisioning' && row.pace === 'slow') return 2500 + row.minutesInState;
  if (row.pace === 'slow') return 2000 + row.stepRatio * 100;
  if (row.state === 'ready') return 1000 + row.minutesInState; // provisioned but idle = paying for nothing
  if (row.state === 'deprovisioned') return -1;
  return row.progress === 1 ? 0 : 500 - row.progress * 100;
}

export function toRow(env, now) {
  const step = STEPS[env.step - 1];
  const onStepMs = env.state === 'in_use' && !env.completedAt ? now - env.stepStartedAt : 0;
  const done = env.completedAt ? TOTAL_STEPS : env.step - 1;
  const row = {
    id: env.id,
    learner: env.learner,
    region: env.region,
    sku: env.sku,
    ratePerHour: env.ratePerHour,
    state: env.state,
    minutesInState: (now - env.stateSince) / MIN,
    step: env.step,
    stepTitle: step.title,
    stepExpectedMin: step.expectedMin,
    stepsDone: done,
    progress: done / TOTAL_STEPS,
    completed: Boolean(env.completedAt),
    minutesOnStep: onStepMs / MIN,
    stepRatio: onStepMs / (step.expectedMin * MIN),
    stepHistoryMin: env.stepDurations.map((d) => d / MIN),
    failure: env.failure,
    attempts: env.attempts,
    spend: spendOf(env, now),
  };
  // One timer the instructor reads: time on step while working, otherwise time in the current state.
  row.timerMin = row.state === 'in_use' && !row.completed ? row.minutesOnStep : row.state === 'deprovisioned' || row.completed ? 0 : row.minutesInState;
  row.pace = paceOf(env, now);
  row.attention = attentionScore(row);
  return row;
}

// ---------- querying ----------
const SORTS = {
  attention: (r) => r.attention,
  learner: (r) => r.learner,
  id: (r) => r.id,
  state: (r) => STATES.indexOf(r.state),
  progress: (r) => r.progress + r.stepRatio / 1000,
  minutesOnStep: (r) => r.timerMin,
  spend: (r) => r.spend,
};
const PACES = ['ok', 'slow', 'stuck'];

const csv = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
const num = (v, lo, hi) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

// Single validator for every filter source: query string, UI, or the AI compiler.
// Unknown fields and out-of-vocabulary values are dropped, never trusted.
export function sanitizeFilter(input = {}) {
  const f = {};
  const states = csv(input.states).filter((s) => STATES.includes(s));
  if (states.length) f.states = [...new Set(states)];
  const steps = csv(input.steps).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL_STEPS);
  if (steps.length) f.steps = [...new Set(steps)].sort((a, b) => a - b);
  const pace = csv(input.pace).filter((p) => PACES.includes(p));
  if (pace.length) f.pace = [...new Set(pace)];
  const regions = csv(input.regions).filter((r) => REGIONS.includes(r));
  if (regions.length) f.regions = [...new Set(regions)];
  const codes = csv(input.failureCodes).filter((c) => c in FAILURES);
  if (codes.length) f.failureCodes = [...new Set(codes)];
  const minOn = num(input.minOnStepMin, 0, 600);
  if (minOn !== undefined) f.minOnStepMin = minOn;
  const maxOn = num(input.maxOnStepMin, 0, 600);
  if (maxOn !== undefined) f.maxOnStepMin = maxOn;
  const minSpend = num(input.minSpend, 0, 10_000);
  if (minSpend !== undefined) f.minSpend = minSpend;
  if (typeof input.q === 'string' && input.q.trim()) f.q = input.q.trim().slice(0, 60);
  if (input.sort in SORTS) f.sort = input.sort;
  if (input.dir === 'asc' || input.dir === 'desc') f.dir = input.dir;
  return f;
}

export function query(ws, filter, now = Date.now()) {
  const f = sanitizeFilter(filter);
  const q = f.q?.toLowerCase();
  let rows = ws.envs.map((e) => toRow(e, now)).filter((r) =>
    (!f.states || f.states.includes(r.state)) &&
    (!f.steps || (f.steps.includes(r.step) && r.state === 'in_use' && !r.completed)) &&
    (!f.pace || f.pace.includes(r.pace)) &&
    (!f.regions || f.regions.includes(r.region)) &&
    (!f.failureCodes || (r.failure && f.failureCodes.includes(r.failure.code))) &&
    (f.minOnStepMin === undefined || r.timerMin >= f.minOnStepMin) &&
    (f.maxOnStepMin === undefined || (r.timerMin > 0 && r.timerMin <= f.maxOnStepMin)) &&
    (f.minSpend === undefined || r.spend >= f.minSpend) &&
    (!q || r.learner.toLowerCase().includes(q) || r.id.includes(q)));

  const sort = f.sort ?? 'attention';
  const dir = f.dir ?? (sort === 'learner' || sort === 'id' ? 'asc' : 'desc');
  const key = SORTS[sort];
  const sign = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = typeof ka === 'string' ? ka.localeCompare(kb) : ka - kb;
    return c * sign || a.id.localeCompare(b.id);
  });
  return { filter: { ...f, sort, dir }, total: ws.envs.length, count: rows.length, rows };
}

export function summarize(ws, now = Date.now()) {
  const rows = ws.envs.map((e) => toRow(e, now));
  const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
  const byPace = { ok: 0, slow: 0, stuck: 0 };
  const failureCodes = {};
  const funnel = STEPS.map((s) => ({ step: s.n, title: s.title, expectedMin: s.expectedMin, active: 0, slow: 0, stuck: 0, medianMin: null, _t: [] }));
  let spend = 0, burnPerHour = 0, idleBurnPerHour = 0, wasted = 0, progressSum = 0, completed = 0;
  const completionMins = [];

  for (const [i, r] of rows.entries()) {
    const env = ws.envs[i];
    byState[r.state]++;
    spend += r.spend;
    wasted += idleFailedSpend(env, now);
    progressSum += r.progress;
    if (BILLABLE.has(r.state)) burnPerHour += r.ratePerHour;
    if (r.state === 'failed' || r.state === 'ready') idleBurnPerHour += r.ratePerHour;
    if (r.failure) failureCodes[r.failure.code] = (failureCodes[r.failure.code] ?? 0) + 1;
    if (r.completed) {
      completed++;
      completionMins.push(r.stepHistoryMin.reduce((a, b) => a + b, 0));
    }
    if (r.state === 'in_use' && !r.completed) {
      byPace[r.pace]++;
      const b = funnel[r.step - 1];
      b.active++;
      if (r.pace !== 'ok') b[r.pace]++;
      b._t.push(r.minutesOnStep);
    }
  }
  for (const b of funnel) {
    b.medianMin = median(b._t);
    delete b._t;
  }

  const hoursLeft = Math.max(0, (ws.session.plannedEndAt - now) / 3_600_000);
  return {
    session: { ...ws.session, now, elapsedMin: (now - ws.session.startedAt) / MIN },
    total: rows.length,
    byState,
    active: byState.ready + byState.in_use,
    failures: byState.failed,
    failureCodes,
    pace: byPace,
    spend: {
      total: spend,
      burnPerHour,
      idleBurnPerHour,
      wastedOnFailed: wasted,
      projectedAtEnd: spend + burnPerHour * hoursLeft,
    },
    completion: {
      averagePct: (progressSum / rows.length) * 100,
      completed,
      medianMinutesToComplete: median(completionMins),
    },
    funnel,
    // Compact per-seat status in fixed lab-number order for the room map.
    seats: rows.map((r) => ({ id: r.id, learner: r.learner, state: r.state, pace: r.pace, step: r.step, done: r.stepsDone, completed: r.completed })),
    version: ws.version,
  };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- mutations ----------
function log(ws, now, env, kind, text) {
  ws.events.push({ seq: ws.events.length ? ws.events.at(-1).seq + 1 : 1, at: now, envId: env.id, learner: env.learner, kind, text });
  if (ws.events.length > 200) ws.events.shift();
  ws.version++;
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export function reprovision(ws, ids, now = Date.now()) {
  const results = [];
  for (const id of ids) {
    const env = ws.envs.find((e) => e.id === id);
    if (!env) { results.push({ id, ok: false, error: 'not_found' }); continue; }
    if (env.state !== 'failed') { results.push({ id, ok: false, error: `not_failed (${env.state})` }); continue; }
    const prev = env.failure?.code;
    setState(env, 'provisioning', now);
    env.failure = null;
    env.attempts++;
    // Reprovision restores the learner's checkpoint; the clock for the current step restarts.
    env.stepStartedAt = now;
    log(ws, now, env, 'reprovision', `Reprovision requested after ${prev} (attempt ${env.attempts})`);
    results.push({ id, ok: true, row: toRow(env, now) });
  }
  return results;
}

// ---------- drift ----------
// Called on a timer. Hazard rates are per-minute so behaviour is independent of tick length.
export function tick(ws, dtMs, now = Date.now(), rnd = Math.random) {
  const dtMin = dtMs / MIN;
  const p = (perMin) => rnd() < 1 - Math.exp(-perMin * dtMin);
  for (const env of ws.envs) {
    switch (env.state) {
      case 'provisioning': {
        const age = (now - env.stateSince) / MIN;
        if (age > 2 && p(0.02 * (env.attempts > 1 ? 0.3 : 1))) {
          setState(env, 'failed', now);
          const code = rnd() < 0.5 ? 'DeploymentTimeout' : rnd() < 0.5 ? 'AllocationFailed' : 'QuotaExceeded';
          env.failure = { code, message: FAILURES[code] };
          log(ws, now, env, 'failed', `Provisioning failed: ${code}`);
        } else if (age > 2.5 && p(0.35)) {
          setState(env, 'ready', now);
          log(ws, now, env, 'ready', 'Environment ready');
        }
        break;
      }
      case 'ready':
        if (p(0.25)) {
          setState(env, 'in_use', now);
          if (!env.stepStartedAt || env.stepStartedAt < env.stateSince) env.stepStartedAt = now;
          log(ws, now, env, 'started', `Learner connected, on step ${env.step}`);
        }
        break;
      case 'in_use': {
        if (env.completedAt) {
          if (p(0.06)) { setState(env, 'deprovisioned', now); log(ws, now, env, 'deprovisioned', 'Torn down after completion'); }
          break;
        }
        if (p(0.0025)) {
          setState(env, 'failed', now);
          env.failure = { code: 'VMUnresponsive', message: FAILURES.VMUnresponsive };
          log(ws, now, env, 'failed', `Failed on step ${env.step}: VMUnresponsive`);
          break;
        }
        const expected = STEPS[env.step - 1].expectedMin * env._pace;
        const onStep = (now - env.stepStartedAt) / MIN;
        if (onStep > expected * 0.5 && p(1 / expected)) {
          env.stepDurations.push(now - env.stepStartedAt);
          if (env.step === TOTAL_STEPS) {
            env.completedAt = now;
            log(ws, now, env, 'completed', 'Completed all steps');
          } else {
            env.step++;
            env.stepStartedAt = now;
            log(ws, now, env, 'step', `Advanced to step ${env.step}`);
          }
          ws.version++;
        }
        break;
      }
    }
  }
}
