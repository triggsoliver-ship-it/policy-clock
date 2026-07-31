'use strict';
/**
 * Policy Clock — single-file server. No build step, no dependencies.
 * Run: node server.js   then open http://localhost:3000
 *
 *   GET  /                 landing page
 *   POST /subscribe        email capture -> SQLite + data/waitlist.jsonl
 *   GET  /app              school picker
 *   GET  /app/:slug        the compliance dashboard
 *   POST /app/:slug/record record a publication date
 *   GET  /app/:slug/pack   plain-text governors' evidence pack
 *   GET  /api/:slug        JSON report
 *   POST /checkout         Stripe Checkout (test mode) — placeholder keys only
 *   GET  /health
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { evaluate, governorsSummary } = require('./lib/engine');
const { REQUIREMENTS, applicable } = require('./lib/requirements');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- storage
function openDb() {
  const wanted = process.env.CLOCK_DB || path.join(DATA, 'clock.db');
  try {
    const d = new DatabaseSync(wanted);
    d.exec('CREATE TABLE IF NOT EXISTS _probe (x INTEGER)'); d.exec('DROP TABLE _probe');
    return { db: d, persistent: true, location: wanted };
  } catch (err) {
    console.warn(`[storage] ${wanted} unusable (${err.message}) — SQLite needs POSIX file locking, which iCloud/Dropbox/SMB mounts do not provide.`);
    console.warn('[storage] Falling back to in-memory. Sign-ups still append to data/waitlist.jsonl. Set CLOCK_DB to a local path for persistence.');
    return { db: new DatabaseSync(':memory:'), persistent: false, location: ':memory:' };
  }
}
const { db, persistent: DB_PERSISTENT, location: DB_LOCATION } = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
    school TEXT, role TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, school_slug TEXT NOT NULL,
    requirement_id TEXT NOT NULL, published_at TEXT NOT NULL, url TEXT,
    recorded_at TEXT NOT NULL, UNIQUE(school_slug, requirement_id));
`);

// ---------------------------------------------------------------- seed
const SEED = require('./data/schools.json');
function loadState(slug) {
  const rows = db.prepare('SELECT requirement_id, published_at, url FROM publications WHERE school_slug = ?').all(slug);
  const state = { ...(SEED.find(s => s.slug === slug)?.state || {}) };
  for (const r of rows) state[r.requirement_id] = { published_at: r.published_at, url: r.url };
  return state;
}
const school = slug => SEED.find(s => s.slug === slug);

const PRICING = [
  { id: 'school', name: 'Single school', price: 39, blurb: 'One school, one clock.',
    features: ['Every statutory publishing deadline tracked', 'Email reminders 45 days out', 'Governors\' evidence pack', 'Source citation on every item'] },
  { id: 'federation', name: 'Federation', price: 149, featured: true, blurb: 'Up to five schools.',
    features: ['Everything in Single school', 'Up to 5 schools', 'Cross-school dashboard', 'Consolidated board report'] },
  { id: 'trust', name: 'Trust', price: 399, blurb: 'Six schools or more.',
    features: ['Everything in Federation', 'Unlimited schools', 'Trust-level exception report', 'CSV export and API', 'Priority support'] },
];

// ---------------------------------------------------------------- helpers
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function send(res, code, body, type = 'text/html; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' }); res.end(body);
}
const json = (res, code, o) => send(res, code, JSON.stringify(o, null, 2), 'application/json; charset=utf-8');
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 1e6) { reject(new Error('too large')); req.destroy(); } b += c; });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
}
const parseForm = b => Object.fromEntries(new URLSearchParams(b));
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d));

const CSS = `
:root{--ink:#101c17;--ink-2:#41544c;--line:#dfe6e2;--bg:#fff;--bg-2:#f5f9f7;
 --accent:#0f6e4f;--accent-soft:#e8f5f0;--red:#a5231b;--amber:#8a5300;
 --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace}
*{box-sizing:border-box}
body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
.wrap{max-width:1060px;margin:0 auto;padding:0 28px}
a{color:var(--accent)}
h1,h2,h3{line-height:1.15;letter-spacing:-.02em;margin:0}
h1{font-size:clamp(2.2rem,5vw,3.7rem);font-weight:680}
h2{font-size:clamp(1.45rem,3vw,2.05rem);font-weight:660;margin-bottom:.6rem}
h3{font-size:1.05rem;font-weight:640}
p{margin:0 0 1rem}
.lede{font-size:1.18rem;color:var(--ink-2);max-width:36em}
header.site{border-bottom:1px solid var(--line);padding:20px 0;position:sticky;top:0;background:rgba(255,255,255,.93);backdrop-filter:blur(8px);z-index:10}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;gap:20px}
.brand{font-weight:680;letter-spacing:-.02em;text-decoration:none;color:var(--ink);font-size:1.05rem}
.brand span{color:var(--accent)}
.nav{display:flex;gap:24px;align-items:center;font-size:.93rem}
.nav a{color:var(--ink-2);text-decoration:none}.nav a:hover{color:var(--ink)}
.btn{display:inline-block;background:var(--accent);color:#fff;border:1px solid var(--accent);padding:12px 22px;border-radius:7px;font-weight:600;text-decoration:none;cursor:pointer;font-size:.96rem}
.btn:hover{filter:brightness(.93)}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
.btn.sm{padding:7px 13px;font-size:.85rem}
section{padding:86px 0;border-bottom:1px solid var(--line)}
.hero{padding:100px 0 88px}
.eyebrow{font:600 .8rem/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:20px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:32px;margin-top:42px}
.card{border:1px solid var(--line);border-radius:11px;padding:26px}
.card p{color:var(--ink-2);margin:0;font-size:.95rem}
.num{font:640 .82rem/1 var(--mono);color:var(--accent);margin-bottom:14px;display:block}
.price-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:22px;margin-top:38px;align-items:start}
.tier{border:1px solid var(--line);border-radius:11px;padding:30px}
.tier.featured{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.tier .amt{font-size:2.4rem;font-weight:680;letter-spacing:-.03em}
.tier .per{color:var(--ink-2);font-size:.88rem}
.tier ul{list-style:none;padding:0;margin:20px 0 26px;font-size:.93rem;color:var(--ink-2)}
.tier li{padding:7px 0 7px 22px;position:relative}
.tier li::before{content:'';position:absolute;left:0;top:14px;width:9px;height:2px;background:var(--accent)}
.tier .btn{width:100%;text-align:center}
form.capture{display:flex;gap:10px;flex-wrap:wrap;max-width:560px;margin-top:24px}
input,select{font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--ink);min-width:0}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}
form.capture input{flex:1 1 220px}
.note{font-size:.86rem;color:var(--ink-2)}
footer{padding:44px 0;color:var(--ink-2);font-size:.88rem}
.banner{padding:14px 18px;border-radius:8px;font-size:.92rem;margin:0 0 24px}
.banner.warn{background:#fff8ec;border:1px solid #f0dcb8;color:#6b4708}
.banner.ok{background:var(--accent-soft);border:1px solid #b9ddd0;color:#0a4a36}
table{width:100%;border-collapse:collapse;font-size:.93rem}
th,td{text-align:left;padding:13px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:600 .75rem/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2)}
.pill{display:inline-block;font-size:.72rem;font-weight:700;padding:3px 9px;border-radius:20px;white-space:nowrap;letter-spacing:.02em}
.pill.missing,.pill.overdue,.pill.stale{background:#fdeceb;color:var(--red)}
.pill.due_soon{background:#fff8ec;color:var(--amber)}
.pill.ok{background:var(--accent-soft);color:var(--accent)}
.pill.must{background:#eceff3;color:#31404f}
.pill.should{background:#f5f5f5;color:#666}
.scorebox{display:flex;gap:34px;flex-wrap:wrap;align-items:center;padding:26px;background:var(--bg-2);border:1px solid var(--line);border-radius:11px;margin-bottom:28px}
.scorebox .big{font-size:3rem;font-weight:680;letter-spacing:-.03em;line-height:1}
.scorebox .big.bad{color:var(--red)}.scorebox .big.good{color:var(--accent)}
.src{font-size:.8rem;color:var(--ink-2);margin-top:7px;font-family:var(--mono);line-height:1.5}
.detail{color:var(--ink-2);font-size:.89rem;margin-top:5px;max-width:56em}
.act{font-weight:600;font-size:.89rem;margin-top:6px}
.skip{position:absolute;left:-9999px}.skip:focus{position:static;display:inline-block;padding:10px;background:var(--accent);color:#fff}
.rowform{display:flex;gap:6px;align-items:center}
.rowform input{padding:7px 9px;font-size:.85rem}
pre{background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:20px;overflow:auto;font-size:.84rem;line-height:1.6}
@media(max-width:640px){.nav{display:none}section{padding:58px 0}.hero{padding:62px 0}}
`;

const shell = (title, body, desc = '') => `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><style>${CSS}</style></head>
<body><a href="#main" class="skip">Skip to main content</a>
<header class="site"><div class="wrap">
  <a class="brand" href="/">Policy<span>Clock</span></a>
  <nav class="nav" aria-label="Main"><a href="/#how">How it works</a><a href="/#pricing">Pricing</a>
  <a href="/app">Live demo</a><a class="btn" href="/#waitlist">Get early access</a></nav>
</div></header>
<main id="main">${body}</main>
<footer><div class="wrap"><p><strong>Policy Clock</strong> — statutory publishing deadlines for English schools, with the source next to every one.</p>
<p class="note">A compliance tracking tool, not legal advice. Requirements are re-derived from current DfE guidance and legislation; DfE's own consolidated policy list was withdrawn on 7 March 2024.</p></div></footer></body></html>`;

// ---------------------------------------------------------------- landing
function landing(msg) {
  const tiers = PRICING.map(t => `<div class="tier${t.featured ? ' featured' : ''}">
    <h3>${t.name}</h3><p class="note" style="margin:.3rem 0 1rem">${esc(t.blurb)}</p>
    <div class="amt">£${t.price}<span class="per"> /month</span></div>
    <ul>${t.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
    <form method="POST" action="/checkout"><input type="hidden" name="tier" value="${t.id}">
    <button class="btn${t.featured ? '' : ' ghost'}" type="submit">Start free 30 day trial</button></form></div>`).join('');

  return shell('Policy Clock — never miss a statutory publishing deadline',
    `${msg ? `<div class="wrap"><div class="banner ok" role="status">${esc(msg)}</div></div>` : ''}
<section class="hero"><div class="wrap">
  <p class="eyebrow">For school business managers, clerks and governors</p>
  <h1>Your pupil premium statement<br>was due on 31 December.</h1>
  <p class="lede">English schools carry more than twenty separate statutory publishing duties, each on its own clock — 31 December, 15 March, 31 July, 28 February, every three years, every four years. There is no longer a single government list of them. Policy Clock keeps the register, counts the days, and shows the source next to every deadline.</p>
  <p><a class="btn" href="/app">See it on a real school profile</a> &nbsp; <a class="btn ghost" href="#how">How it works</a></p>
</div></section>

<section id="how"><div class="wrap">
  <h2>The list you used to work from no longer exists</h2>
  <p class="lede">DfE withdrew "Statutory policies for schools and academy trusts" on 7 March 2024. Nothing replaced it. The duties did not go away — they were simply scattered back across the School Information Regulations, the Equality Act, the Children and Families Act and a dozen guidance pages that update on their own schedules.</p>
  <div class="grid3">
    <div class="card"><span class="num">01</span><h3>One register, rebuilt from source</h3>
      <p>Every requirement traced to legislation or current DfE guidance, with the citation shown beside it. Where a rule comes from withdrawn guidance, we say so rather than quietly passing it off as law.</p></div>
    <div class="card"><span class="num">02</span><h3>Deadlines counted, not listed</h3>
      <p>Fixed dates, annual reviews and three and four year cycles all tracked together, with reminders 45 days out — in time to reach a governors' meeting.</p></div>
    <div class="card"><span class="num">03</span><h3>Evidence, ready for the board</h3>
      <p>One click produces a dated summary showing what is published, what is late and what is coming, with sources. It is what you hand the governors, or Ofsted.</p></div>
  </div>
  <p class="note" style="margin-top:30px">"Must" and "should" are scored separately. Your compliance figure covers only what the law actually requires — DfE recommendations are tracked, but never inflate the number.</p>
</div></section>

<section id="pricing"><div class="wrap">
  <h2>Pricing</h2>
  <p class="lede">Less than an hour of a business manager's time each month.</p>
  <div class="price-grid">${tiers}</div>
  <p class="note" style="margin-top:24px">Prices exclude VAT. Card handling by Stripe; this build runs in Stripe test mode.</p>
</div></section>

<section id="waitlist"><div class="wrap">
  <h2>Get early access</h2>
  <p class="lede">Tell us your school and we will send back a free check of what your website currently publishes against the statutory list.</p>
  <form class="capture" method="POST" action="/subscribe">
    <label class="skip" for="email">Email address</label>
    <input id="email" name="email" type="email" required placeholder="you@yourschool.sch.uk" autocomplete="email">
    <label class="skip" for="school">School</label>
    <input id="school" name="school" placeholder="School or trust name">
    <label class="skip" for="role">Role</label>
    <select id="role" name="role">
      <option value="sbm">School business manager</option><option value="head">Headteacher</option>
      <option value="clerk">Clerk to governors</option><option value="governor">Governor or trustee</option>
      <option value="trust">Trust central team</option><option value="other">Other</option>
    </select>
    <button class="btn" type="submit">Send me a free check</button>
  </form>
  <p class="note" style="margin-top:14px">We use your address to send the check and occasional product updates. Unsubscribe any time.</p>
</div></section>`,
    'Track every statutory publishing deadline for English schools, with the legal source cited next to each one.');
}

// ---------------------------------------------------------------- app
function picker() {
  return shell('Policy Clock — choose a school', `<section style="padding:52px 0"><div class="wrap">
    <h2>Demo schools</h2><p class="lede">Two seeded profiles. One is in reasonable shape; the other is a realistic mess.</p>
    <table><thead><tr><th>School</th><th>Type</th><th>Phase</th><th></th></tr></thead><tbody>
    ${SEED.map(s => `<tr><td><strong>${esc(s.name)}</strong><div class="note">${esc(s.note || '')}</div></td>
      <td>${esc(s.type)}</td><td>${esc(s.phase)}</td>
      <td><a class="btn sm" href="/app/${esc(s.slug)}">Open</a></td></tr>`).join('')}
    </tbody></table></div></section>`);
}

function dashboard(slug, flash) {
  const s = school(slug);
  if (!s) return null;
  const report = evaluate(s, loadState(slug), new Date());
  const bad = report.counts.failingMust > 0;

  const row = r => `<tr>
    <td><span class="pill ${r.status}">${r.status.replace('_', ' ')}</span>
      <div style="margin-top:6px"><span class="pill ${r.force}">${r.force}</span></div></td>
    <td><strong>${esc(r.title)}</strong>
      <div class="detail">${esc(r.detail)}</div>
      ${r.action ? `<div class="act">→ ${esc(r.action)}</div>` : ''}
      <div class="src">${esc(r.source)}</div>
      ${r.provenanceWarning ? `<div class="note" style="color:var(--amber);margin-top:5px">Cycle length comes from guidance DfE has withdrawn — treat as convention, not law.</div>` : ''}</td>
    <td>${esc(r.message)}</td>
    <td><form class="rowform" method="POST" action="/app/${esc(slug)}/record">
      <input type="hidden" name="requirement_id" value="${esc(r.id)}">
      <label class="skip" for="d-${esc(r.id)}">Date published for ${esc(r.title)}</label>
      <input id="d-${esc(r.id)}" type="date" name="published_at" value="${esc(r.published_at || '')}" required>
      <button class="btn sm" type="submit">Save</button></form></td></tr>`;

  const groups = [...new Set(report.results.map(r => r.group))];

  return shell(`Policy Clock — ${s.name}`, `<section style="padding:48px 0"><div class="wrap">
    <p class="note"><a href="/app">← All schools</a></p>
    <h2>${esc(s.name)}</h2>
    <p class="lede">${esc(s.type)} · ${esc(s.phase)} · ${s.employees} employees${s.receives_pupil_premium ? ' · receives pupil premium' : ''}${s.own_admissions_authority ? ' · own admissions authority' : ''}</p>
    ${flash ? `<div class="banner ok" role="status">${esc(flash)}</div>` : ''}
    <div class="scorebox">
      <div><div class="big ${bad ? 'bad' : 'good'}">${report.score}%</div><div class="note">statutory compliance</div></div>
      <div><div class="big">${report.counts.failingMust}</div><div class="note">not compliant</div></div>
      <div><div class="big">${report.counts.dueSoon}</div><div class="note">due within 45 days</div></div>
      <div style="flex:1;min-width:220px"><strong>${esc(report.headline)}</strong>
        <div class="note" style="margin-top:6px">Score counts statutory "must" items only. ${report.counts.recommended} recommended items tracked separately.</div>
        <p style="margin:14px 0 0"><a class="btn sm" href="/app/${esc(slug)}/pack">Governors' evidence pack</a>
        <a class="btn sm ghost" href="/api/${esc(slug)}">JSON</a></p></div>
    </div>
    ${groups.map(g => `<h3 style="margin:34px 0 12px">${esc(g)}</h3>
      <table><caption class="skip">${esc(g)} requirements</caption><thead><tr>
      <th scope="col">Status</th><th scope="col">Requirement and source</th><th scope="col">Position</th><th scope="col">Date published</th>
      </tr></thead><tbody>${report.results.filter(r => r.group === g).map(row).join('')}</tbody></table>`).join('')}
  </div></section>`);
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, landing(q.subscribed ? 'Thanks — we will send your free check shortly.' : null));
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, storage: { persistent: DB_PERSISTENT, location: DB_LOCATION }, schools: SEED.length, requirements: REQUIREMENTS.length });
    }
    if (req.method === 'GET' && url.pathname === '/app') return send(res, 200, picker());

    if (req.method === 'GET' && parts[0] === 'app' && parts[1] && !parts[2]) {
      const page = dashboard(parts[1], q.saved ? 'Publication date recorded.' : null);
      return page ? send(res, 200, page) : send(res, 404, shell('Not found', '<section><div class="wrap"><h2>No such school</h2><p><a href="/app">Back</a></p></div></section>'));
    }

    if (req.method === 'GET' && parts[0] === 'app' && parts[2] === 'pack') {
      const s = school(parts[1]);
      if (!s) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, governorsSummary(evaluate(s, loadState(s.slug), new Date())), 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && parts[0] === 'app' && parts[2] === 'record') {
      const s = school(parts[1]);
      if (!s) return send(res, 404, 'Not found', 'text/plain');
      const f = parseForm(await readBody(req));
      const req_ = REQUIREMENTS.find(r => r.id === f.requirement_id);
      if (!req_ || !applicable(req_, s)) return send(res, 400, shell('Bad request', '<section><div class="wrap"><h2>Unknown requirement for this school</h2></div></section>'));
      if (!validDate(f.published_at)) return send(res, 400, shell('Bad date', '<section><div class="wrap"><h2>That date did not parse</h2><p>Use YYYY-MM-DD.</p></div></section>'));
      db.prepare(`INSERT INTO publications (school_slug,requirement_id,published_at,url,recorded_at) VALUES (?,?,?,?,?)
        ON CONFLICT(school_slug,requirement_id) DO UPDATE SET published_at=excluded.published_at, recorded_at=excluded.recorded_at`)
        .run(s.slug, f.requirement_id, f.published_at, f.url || null, new Date().toISOString());
      res.writeHead(303, { Location: `/app/${s.slug}?saved=1` }); return res.end();
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1]) {
      const s = school(parts[1]);
      if (!s) return json(res, 404, { error: 'no such school' });
      return json(res, 200, evaluate(s, loadState(s.slug), new Date()));
    }

    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const f = parseForm(await readBody(req));
      if (!validEmail(f.email)) return send(res, 400, landing('That email address did not look right — please try again.'));
      const row = { email: f.email.trim().toLowerCase(), school: f.school || null, role: f.role || null, created_at: new Date().toISOString() };
      let isNew = true;
      try {
        db.prepare('INSERT INTO waitlist (email,school,role,created_at) VALUES (?,?,?,?)').run(row.email, row.school, row.role, row.created_at);
      } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; isNew = false; }
      if (isNew) {
        fs.appendFileSync(path.join(DATA, 'waitlist.jsonl'), JSON.stringify(row) + '\n');
        // Also to stdout: on hosts with ephemeral disks (Render free tier), the
        // platform log stream is the durable record of sign-ups.
        console.log('[signup]', JSON.stringify(row));
      }
      res.writeHead(303, { Location: '/?subscribed=1#waitlist' }); return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/checkout') {
      const f = parseForm(await readBody(req));
      const tier = PRICING.find(t => t.id === f.tier);
      if (!tier) return send(res, 400, shell('Unknown plan', '<section><div class="wrap"><h2>Unknown plan</h2><p><a href="/#pricing">Back</a></p></div></section>'));
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key.startsWith('sk_test_')) {
        return send(res, 200, shell('Stripe test mode not configured', `<section><div class="wrap">
          <h2>Checkout is wired up, but not keyed</h2>
          <div class="banner warn">No <code>STRIPE_SECRET_KEY</code> beginning <code>sk_test_</code> is set, so nothing was sent to Stripe.</div>
          <p>Selected plan: <strong>${esc(tier.name)} — £${tier.price}/month</strong>.</p>
          <p><code style="font-family:var(--mono);font-size:.88rem">STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_${esc(tier.id.toUpperCase())}=price_... node server.js</code></p>
          <p>See <strong>SETUP.md</strong>. Never commit a live key.</p>
          <p><a class="btn ghost" href="/#pricing">Back to pricing</a></p></div></section>`));
      }
      const price = process.env[`STRIPE_PRICE_${tier.id.toUpperCase()}`];
      if (!price) return send(res, 500, shell('Missing price', `<section><div class="wrap"><h2>Missing price ID</h2><p>Set <code>STRIPE_PRICE_${esc(tier.id.toUpperCase())}</code>.</p></div></section>`));
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
          success_url: `http://localhost:${PORT}/?subscribed=1`, cancel_url: `http://localhost:${PORT}/#pricing`,
          'subscription_data[trial_period_days]': '30' }),
      });
      const sess = await r.json();
      if (!r.ok) return send(res, 502, shell('Stripe error', `<section><div class="wrap"><h2>Stripe rejected that</h2><pre>${esc(JSON.stringify(sess.error || sess, null, 2))}</pre></div></section>`));
      res.writeHead(303, { Location: sess.url }); return res.end();
    }

    return send(res, 404, shell('Not found', '<section><div class="wrap"><h2>Not found</h2><p><a href="/">Back to the start</a></p></div></section>'));
  } catch (err) {
    console.error(err);
    return send(res, 500, shell('Something broke', `<section><div class="wrap"><h2>Something broke</h2><pre>${esc(err.message)}</pre></div></section>`));
  }
});

if (require.main === module) server.listen(PORT, () => console.log(`Policy Clock on http://localhost:${PORT}`));
module.exports = { server, PRICING, landing };
