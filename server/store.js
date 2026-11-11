// Where the workshop state lives.
// - With Redis env vars (Vercel Marketplace "Upstash for Redis", formerly Vercel KV): one JSON
//   document shared by every serverless instance.
// - Without them (local `npm start`, tests): a single in-memory copy.
import { Redis } from '@upstash/redis';
import { createWorkshop, tick } from './workshop.js';

const TICK_MS = Number(process.env.TICK_MS || 2000);
const SIM_SPEED = Number(process.env.SIM_SPEED || 1);
const MAX_CATCH_UP_MS = 30 * 60_000;
const SEED = Number(process.env.SEED || 42);
const KEY = `workshop:v1:${SEED}`;
const LOCK = `${KEY}:lock`;

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

export const storeKind = redis ? 'redis' : 'memory';

// Drift is applied lazily in fixed steps from the stored clock, so it needs no timer and every
// instance advances the same document.
function catchUp(ws, now = Date.now()) {
  ws.lastTick ??= now;
  if (now - ws.lastTick > MAX_CATCH_UP_MS) ws.lastTick = now - MAX_CATCH_UP_MS;
  let moved = false;
  while (now - ws.lastTick >= TICK_MS) {
    ws.lastTick += TICK_MS;
    tick(ws, TICK_MS * SIM_SPEED, ws.lastTick);
    moved = true;
  }
  return moved;
}

let memory = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ponytail: a 3 s Redis lock (SET NX PX) serialises writers. A writer that outlives the lock could
// race the next one; use a token-checked release (Lua) if writes ever get slow.
async function lock(wait) {
  for (let i = 0; i < (wait ? 20 : 1); i++) {
    if (await redis.set(LOCK, '1', { nx: true, px: 3000 })) return true;
    if (wait) await sleep(100);
  }
  return false;
}

async function load() {
  const ws = await redis.get(KEY);
  return ws ?? createWorkshop({ seed: SEED });
}

/**
 * Runs fn(ws) against the current state.
 * mutate=false: reads. Persists drift only if the write lock is free; otherwise answers from a
 *   locally advanced copy (identical apart from random drift) without saving it.
 * mutate=true: waits for the lock so an instructor action is never overwritten by drift.
 */
export async function withState(fn, { mutate = false } = {}) {
  if (!redis) {
    memory ??= createWorkshop({ seed: SEED });
    catchUp(memory);
    return fn(memory);
  }
  const locked = await lock(mutate);
  if (mutate && !locked) throw Object.assign(new Error('Workshop state is busy, try again'), { status: 503 });
  try {
    const ws = await load();
    const moved = catchUp(ws);
    const result = await fn(ws);
    if (locked && (moved || mutate)) await redis.set(KEY, ws);
    return result;
  } finally {
    if (locked) await redis.del(LOCK);
  }
}
