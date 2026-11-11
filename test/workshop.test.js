import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkshop, query, summarize, reprovision, tick, sanitizeFilter, spendOf } from '../server/workshop.js';
import { parseRules } from '../server/nlfilter.js';

const NOW = Date.UTC(2026, 10, 11, 10, 0, 0);
const fresh = () => createWorkshop({ seed: 42, now: NOW });

test('seed is deterministic and covers every state', () => {
  const a = summarize(fresh(), NOW), b = summarize(fresh(), NOW);
  assert.deepEqual(a.byState, b.byState);
  assert.equal(a.total, 120);
  for (const n of Object.values(a.byState)) assert.ok(n > 0);
});

test('spend = rate x billable runtime, and stops when deprovisioned', () => {
  const ws = fresh();
  const env = ws.envs.find((e) => e.state === 'in_use');
  const hour = 3_600_000;
  const before = spendOf(env, NOW);
  assert.ok(Math.abs(spendOf(env, NOW + hour) - before - env.ratePerHour) < 1e-9);
  const gone = ws.envs.find((e) => e.state === 'deprovisioned');
  assert.equal(spendOf(gone, NOW + hour), spendOf(gone, NOW));
});

test('summary spend equals sum of rows; burn rate counts only billable states', () => {
  const ws = fresh();
  const s = summarize(ws, NOW);
  const rows = query(ws, {}, NOW).rows;
  assert.ok(Math.abs(s.spend.total - rows.reduce((t, r) => t + r.spend, 0)) < 1e-6);
  const billable = rows.filter((r) => r.state !== 'deprovisioned').reduce((t, r) => t + r.ratePerHour, 0);
  assert.ok(Math.abs(s.spend.burnPerHour - billable) < 1e-9);
});

test('reprovision mutates failed envs, rejects others, and shows on next read', () => {
  const ws = fresh();
  const failed = query(ws, { states: 'failed' }, NOW).rows;
  const healthy = query(ws, { states: 'in_use' }, NOW).rows[0];
  const res = reprovision(ws, [failed[0].id, healthy.id, 'lab-999'], NOW);
  assert.deepEqual(res.map((r) => r.ok), [true, false, false]);
  const after = query(ws, { q: failed[0].id }, NOW).rows[0];
  assert.equal(after.state, 'provisioning');
  assert.equal(after.attempts, failed[0].attempts + 1);
  assert.equal(summarize(ws, NOW).failures, failed.length - 1);
});

test('triage sort puts failed first, then stuck', () => {
  const rows = query(fresh(), {}, NOW).rows;
  const firstNonFailed = rows.findIndex((r) => r.state !== 'failed');
  assert.ok(rows.slice(0, firstNonFailed).every((r) => r.state === 'failed'));
  assert.equal(rows[firstNonFailed].pace, 'stuck');
});

test('filter: step + minutes on step', () => {
  const rows = query(fresh(), { steps: '5', minOnStepMin: 20 }, NOW).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) { assert.equal(r.step, 5); assert.ok(r.minutesOnStep >= 20); }
});

test('sanitizeFilter drops anything a model could hallucinate', () => {
  const f = sanitizeFilter({ states: ['failed', 'exploded'], steps: [4, 99, 'x'], pace: 'stuck', regions: 'mars', minOnStepMin: '-5', sort: 'drop table', evil: 1 });
  assert.deepEqual(f, { states: ['failed'], steps: [4], pace: ['stuck'], minOnStepMin: 0 });
});

test('rule fallback compiles the brief example', () => {
  assert.deepEqual(parseRules('everyone stuck on step 4 over 20 min').filter, { states: ['in_use'], steps: [4], minOnStepMin: 20 });
  assert.deepEqual(parseRules('failed with quota errors in east us').filter, { states: ['failed'], regions: ['eastus'], failureCodes: ['QuotaExceeded'] });
  assert.deepEqual(parseRules('who needs help').filter, { pace: ['slow', 'stuck'] });
});

test('drift moves learners forward over time', () => {
  const ws = fresh();
  const steps = () => ws.envs.reduce((t, e) => t + e.step + (e.completedAt ? 1 : 0), 0);
  const before = steps();
  let t = NOW;
  for (let i = 0; i < 300; i++) { t += 2000; tick(ws, 2000, t); }
  assert.ok(steps() > before);
  assert.ok(ws.events.length > 0);
});
