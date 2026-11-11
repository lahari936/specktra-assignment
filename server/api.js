// JSON API shared by the local server (server/index.js) and the Vercel function (api/handler.js).
import { query, summarize, reprovision } from './workshop.js';
import { compile, aiStatus } from './nlfilter.js';
import { withState, storeKind } from './store.js';

const CHAOS = Number(process.env.CHAOS_RATE || 0); // fraction of reads that 503

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 10_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try { return data ? JSON.parse(data) : {}; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

// Demo hooks so reviewers can see every UI state on demand: ?simulate=error|slow|empty
async function simulate(req, url, res) {
  const mode = url.searchParams.get('simulate') ?? req.headers['x-simulate'];
  if (mode === 'slow') await new Promise((r) => setTimeout(r, 2500));
  if (mode === 'error' || (CHAOS && Math.random() < CHAOS)) {
    send(res, 503, { error: 'upstream_unavailable', message: 'Lab orchestrator did not respond (simulated)' });
    return true;
  }
  return mode;
}

const routes = {
  'GET /api/environments': async (req, url, res) => {
    const mode = await simulate(req, url, res);
    if (mode === true) return;
    const result = await withState((ws) => ({ ...query(ws, Object.fromEntries(url.searchParams)), serverTime: Date.now(), version: ws.version }));
    if (mode === 'empty') Object.assign(result, { rows: [], count: 0, total: 0 });
    send(res, 200, result);
  },
  'GET /api/summary': async (req, url, res) => {
    const mode = await simulate(req, url, res);
    if (mode === true) return;
    send(res, 200, { ...(await withState((ws) => summarize(ws))), store: storeKind });
  },
  'GET /api/events': async (req, url, res) => {
    const since = Number(url.searchParams.get('since') || 0);
    send(res, 200, await withState((ws) => ({ events: ws.events.filter((e) => e.seq > since).slice(-50) })));
  },
  'POST /api/environments/reprovision': async (req, url, res) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
    if (!ids.length) return send(res, 400, { error: 'ids_required' });
    const { results, version } = await withState((ws) => ({ results: reprovision(ws, ids), version: ws.version }), { mutate: true });
    const ok = results.filter((r) => r.ok).length;
    send(res, ok ? 200 : 409, { requested: ids.length, reprovisioned: ok, results, version });
  },
  'POST /api/nl-filter': async (req, url, res) => {
    const body = await readJson(req);
    send(res, 200, await compile(body.text));
  },
  'GET /api/ai': async (req, url, res) => send(res, 200, aiStatus()),
};

export async function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'not_found', message: `No API route ${req.method} ${url.pathname}` });
    await route(req, url, res);
  } catch (err) {
    send(res, err.status ?? 500, { error: err.message ?? 'internal_error' });
  }
}
