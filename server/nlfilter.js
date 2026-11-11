// Natural-language filter -> structured filter object.
// The model only ever produces a *filter*; it never sees or returns learner data, and its
// output goes through the same sanitizeFilter() as the query string. If the model is not
// configured, slow, refuses, or returns junk, a deterministic rule parser takes over.

import Anthropic from '@anthropic-ai/sdk';
import { STEPS, REGIONS, FAILURES, STATES, sanitizeFilter } from './workshop.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 8000);

let client = null;
const hasCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE;
if (process.env.AI_DISABLED !== '1' && hasCreds) {
  try {
    // No credentials => rules only, with zero added latency.
    client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });
  } catch {
    client = null;
  }
}

const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    states: { type: 'array', items: { type: 'string', enum: STATES } },
    steps: { type: 'array', items: { type: 'integer' } },
    pace: { type: 'array', items: { type: 'string', enum: ['ok', 'slow', 'stuck'] } },
    regions: { type: 'array', items: { type: 'string', enum: REGIONS } },
    failureCodes: { type: 'array', items: { type: 'string', enum: Object.keys(FAILURES) } },
    minOnStepMin: { type: 'number' },
    maxOnStepMin: { type: 'number' },
    minSpend: { type: 'number' },
    q: { type: 'string' },
    sort: { type: 'string', enum: ['attention', 'learner', 'id', 'state', 'progress', 'minutesOnStep', 'spend'] },
    dir: { type: 'string', enum: ['asc', 'desc'] },
    explanation: { type: 'string' },
    unsupported: { type: 'string' },
  },
  required: ['explanation'],
};

const SYSTEM = `You translate an instructor's question about a live Azure lab workshop into a JSON filter.
Each row is one learner's lab environment with these fields:
- state: ${STATES.join(' | ')} ("active" means ready or in_use; "broken"/"errored" means failed)
- step: current lab step 1-${STEPS.length}. Steps: ${STEPS.map((s) => `${s.n}=${s.title} (~${s.expectedMin}m)`).join('; ')}
- timer (filtered by minOnStepMin / maxOnStepMin): minutes on the current step while in_use; minutes in the current state for provisioning, ready and failed
- pace: ok | slow (>=1.5x expected time on step) | stuck (>=2x expected)
- region: ${REGIONS.join(', ')}
- failure code (failed only): ${Object.entries(FAILURES).map(([k, v]) => `${k} (${v})`).join('; ')}
- spend: dollars accrued so far
Rules:
- Only set fields the question asks for. "stuck on step 4 over 20 min" => steps [4], minOnStepMin 20 (do NOT also add pace unless the word stuck stands alone without a time).
- "stuck" with no time threshold => pace ["stuck"]. "struggling"/"behind"/"needs help" => pace ["slow","stuck"].
- A learner name or lab id => q.
- "most expensive"/"top spenders" => sort spend desc. "longest on step" => sort minutesOnStep desc.
- explanation: one short sentence restating the filter in plain words.
- If part of the question cannot be expressed with these fields, describe that part in "unsupported" and ignore it. Never invent fields.`;

async function viaModel(text) {
  if (!client) return { error: 'not_configured' };
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FILTER_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
    });
    if (res.stop_reason === 'refusal') return { error: 'refused' };
    const block = res.content.find((b) => b.type === 'text');
    if (!block) return { error: 'empty_response' };
    const raw = JSON.parse(block.text);
    return { raw };
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) return { error: 'timeout' };
    if (err instanceof Anthropic.AuthenticationError) return { error: 'auth' };
    if (err instanceof Anthropic.RateLimitError) return { error: 'rate_limited' };
    if (err instanceof Anthropic.APIConnectionError) return { error: 'unreachable' };
    if (err instanceof Anthropic.APIError) return { error: `api_${err.status ?? 'error'}` };
    if (err instanceof SyntaxError) return { error: 'bad_json' };
    return { error: 'unknown' };
  }
}

// ---------- deterministic fallback ----------
const STATE_WORDS = [
  [/\bprovision(ing)?\b|\bspinning up\b|\bbooting\b/, 'provisioning'],
  [/\bready\b|\bidle\b|\bnot started\b|\bhaven'?t started\b/, 'ready'],
  [/\bin[ _-]?use\b|\bworking\b/, 'in_use'],
  [/\bfail(ed|ing|ure|ures)?\b|\bbroken\b|\berror(ed|s)?\b/, 'failed'],
  [/\bdeprovision(ed)?\b|\btorn down\b|\bdeleted\b|\bfinished\b|\bdone\b/, 'deprovisioned'],
];
const CODE_WORDS = [
  [/quota/, 'QuotaExceeded'],
  [/allocat|capacity|sku/, 'AllocationFailed'],
  [/timeout|timed out/, 'DeploymentTimeout'],
  [/policy/, 'PolicyDenied'],
  [/unresponsive|crash|health/, 'VMUnresponsive'],
];
const REGION_WORDS = [
  [/east ?us|virginia/, 'eastus'],
  [/west ?europe|amsterdam|netherlands/, 'westeurope'],
  [/southeast ?asia|singapore/, 'southeastasia'],
  [/central ?india|india|pune/, 'centralindia'],
];

export function parseRules(text) {
  const t = text.toLowerCase();
  const f = {};
  const notes = [];

  const states = new Set();
  for (const [re, s] of STATE_WORDS) if (re.test(t)) states.add(s);
  if (/\bactive\b/.test(t)) { states.add('ready'); states.add('in_use'); }
  const codes = CODE_WORDS.filter(([re]) => re.test(t)).map(([, c]) => c);
  if (codes.length) { f.failureCodes = codes; states.add('failed'); }

  const steps = new Set();
  for (const m of t.matchAll(/\bsteps?\s+(\d)(?:\s*(?:-|to|through)\s*(\d))?/g)) {
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) steps.add(i);
  }
  for (const s of STEPS) {
    const key = s.title.toLowerCase().split(/[ &]+/).find((w) => w.length > 4 && !['azure', 'deploy', 'rules', 'verify'].includes(w));
    if (key && t.includes(key)) steps.add(s.n);
  }
  if (steps.size) f.steps = [...steps];

  const over = t.match(/(?:over|more than|longer than|at least|>=?|past|beyond)\s*(\d+(?:\.\d+)?)\s*(m\b|min|mins|minutes|h\b|hr|hour)/);
  if (over) f.minOnStepMin = Number(over[1]) * (/^h/.test(over[2]) ? 60 : 1);
  const under = t.match(/(?:under|less than|below|within|<=?)\s*(\d+(?:\.\d+)?)\s*(m\b|min|mins|minutes|h\b|hr|hour)/);
  if (under) f.maxOnStepMin = Number(under[1]) * (/^h/.test(under[2]) ? 60 : 1);
  if ((f.minOnStepMin !== undefined || f.steps) && !states.size) states.add('in_use');

  if (/\bstuck\b/.test(t) && f.minOnStepMin === undefined) f.pace = ['stuck'];
  else if (/\bslow\b|\bbehind\b|\bstruggl|\bneed(s)? help\b|\bat[- ]risk\b/.test(t)) f.pace = ['slow', 'stuck'];
  if (/\bon (track|pace)\b/.test(t)) f.pace = ['ok'];

  const regions = REGION_WORDS.filter(([re]) => re.test(t)).map(([, r]) => r);
  if (regions.length) f.regions = regions;

  const spend = t.match(/(?:over|more than|above)\s*\$\s*(\d+(?:\.\d+)?)|\$\s*(\d+(?:\.\d+)?)\s*(?:or more|\+)/);
  if (spend) { f.minSpend = Number(spend[1] ?? spend[2]); delete f.minOnStepMin; }
  if (/expensive|spend|cost/.test(t)) { f.sort = 'spend'; f.dir = 'desc'; }
  else if (/longest|slowest|oldest/.test(t)) { f.sort = 'minutesOnStep'; f.dir = 'desc'; }

  const id = t.match(/\blab-\d{1,3}\b/);
  if (id) f.q = id[0];

  if (states.size) f.states = [...states];
  const clean = sanitizeFilter(f);
  if (!Object.keys(clean).length) notes.push('No recognisable fields; try words like "failed", "step 3", "over 20 min", "stuck", "quota".');
  return { filter: clean, note: notes[0] };
}

const REASON = {
  not_configured: 'No model key configured',
  timeout: 'Model timed out',
  auth: 'Model key rejected',
  rate_limited: 'Model rate-limited',
  unreachable: 'Model unreachable',
  refused: 'Model declined the request',
  bad_json: 'Model returned malformed output',
  empty_response: 'Model returned nothing',
};

export async function compile(text) {
  text = String(text ?? '').slice(0, 300).trim();
  if (!text) return { filter: {}, source: 'none', explanation: '' };
  const started = Date.now();
  const m = await viaModel(text);
  if (m.raw) {
    const { explanation, unsupported, ...rest } = m.raw;
    const filter = sanitizeFilter(rest);
    return { filter, source: 'model', model: MODEL, explanation: String(explanation ?? '').slice(0, 200), unsupported: unsupported ? String(unsupported).slice(0, 200) : undefined, ms: Date.now() - started };
  }
  const r = parseRules(text);
  return {
    filter: r.filter,
    source: 'rules',
    explanation: r.note ?? 'Parsed with built-in keyword rules.',
    degradedReason: REASON[m.error] ?? `Model error (${m.error})`,
    ms: Date.now() - started,
  };
}

export const aiStatus = () => ({ configured: Boolean(client), model: client ? MODEL : null });
