'use strict';
/**
 * Policy Clock — single-file server. No build step, no dependencies.
 * Run: node server.js   then open http://localhost:3000
 *
 *   GET  /                       landing page
 *   POST /subscribe              email capture -> SQLite + data/waitlist.jsonl
 *   POST /checkout               Stripe Checkout (live or test, per STRIPE_SECRET_KEY)
 *   GET  /welcome?session_id=    post-payment page: the one-time "Set up your school" link
 *   GET|POST /setup/<token>      first school + password, then signed in
 *   GET|POST /login  POST /logout
 *   GET  /app                    signed in: your schools. Otherwise: the demo picker
 *   GET|POST /app/new            add a school, within the plan's limit
 *   GET  /app/:slug              the compliance dashboard (a demo, or your own school)
 *   POST /app/:slug/record       record a publication date
 *   GET|POST /app/:slug/settings edit a school's profile
 *   GET  /app/:slug/pack         plain-text governors' evidence pack
 *   GET  /api/:slug              JSON report
 *   POST /stripe/webhook         signed Stripe events -> provisioning (lib/provision.js)
 *   GET  /health
 *
 * Storage is in lib/db.js, provisioning in lib/provision.js, passwords and CSRF in
 * lib/auth.js, plans in lib/plans.js. The two demo schools are still data/schools.json.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { evaluate, governorsSummary } = require('./lib/engine');
const { REQUIREMENTS, applicable } = require('./lib/requirements');
const { TERMS, PRIVACY } = require('./lib/legal');
const { PRICING, planById, schoolLimitFor } = require('./lib/plans');
// `q` from lib/db is renamed `all` here because `q` is the query string inside the handler.
const { one, run, q: all, purgeExpired, DATA, DB_PERSISTENT, DB_LOCATION } = require('./lib/db');
const { hashPassword, verifyPassword, newSessionToken, suggestPassword, csrfValid, csrfField, originOk, SECRET_IS_EPHEMERAL } = require('./lib/auth');
const provision = require('./lib/provision');

const PORT = process.env.PORT || 3000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 24);
const MIN_PASSWORD_LENGTH = 12;   // matches lib/setpassword.js
const SUPPORT = 'oli@parishinabox.co.uk';

// ---------------------------------------------------------------- schools
// Two kinds. The demo schools come from data/schools.json and are public: they are the
// live demo the marketing site links to. Customer schools come from the database and
// are only visible to the account that owns them. Both go through the same engine.
const SEED = require('./data/schools.json');
function school(slug) {
  const demo = SEED.find(s => s.slug === slug);
  if (demo) return { ...demo, demo: true };
  const row = provision.schoolBySlug(slug);
  return row ? { ...row, demo: false } : null;
}
function loadState(slug) {
  const rows = all('SELECT requirement_id, published_at, url FROM publications WHERE school_slug = ?', slug);
  const state = { ...(SEED.find(s => s.slug === slug)?.state || {}) };
  for (const r of rows) state[r.requirement_id] = { published_at: r.published_at, url: r.url };
  return state;
}

// ---------------------------------------------------------------- helpers
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff',
    // Session ids and setup tokens travel in URLs; never leak them to a third party via Referer.
    'Referrer-Policy': 'strict-origin-when-cross-origin', ...extra }); res.end(body);
}
const json = (res, code, o) => send(res, code, JSON.stringify(o, null, 2), 'application/json; charset=utf-8');
const redirect = (res, to, extra = {}) => { res.writeHead(303, { Location: to, ...extra }); res.end(); };
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
const nz = v => (v == null || String(v).trim() === '' ? null : String(v).trim());

// Stripe signs webhooks as `t=<unix>,v1=<hex>` over `<t>.<raw body>`. Verified here by
// hand rather than pulling in the Stripe SDK, because this repo has no dependencies.
function verifyStripeSignature(raw, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map(p => p.split('=', 2)));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8'), b = Buffer.from(parts.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Read from Stripe's API with the secret key. Used by /welcome to confirm a Checkout
 * Session is real before saying anything reassuring, and by the webhook to read a
 * subscription's metadata when the session itself does not name the plan.
 */
async function stripeGet(p) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!/^sk_(test|live)_/.test(key)) throw new Error('STRIPE_SECRET_KEY is not set');
  const r = await fetch(`https://api.stripe.com${p}`, { headers: { Authorization: `Bearer ${key}` } });
  const body = await r.json();
  if (!r.ok) throw new Error((body.error && body.error.message) || `Stripe returned ${r.status}`);
  return body;
}

/**
 * Which plan a Checkout Session bought. From 2 September 2026 /checkout stamps the
 * plan on the session itself (client_reference_id and metadata.tier). Sessions made
 * before that only carried it on the subscription, so fall back to fetching that.
 */
async function planForSession(session) {
  const direct = provision.planFromSession(session);
  if (direct) return direct;
  const subId = session && session.subscription && (typeof session.subscription === 'object' ? session.subscription.id : session.subscription);
  if (!subId) return null;
  try {
    const sub = await stripeGet(`/v1/subscriptions/${encodeURIComponent(subId)}`);
    return provision.planFromSession({ metadata: sub.metadata || {} });
  } catch (e) {
    console.error('[provision] could not read the subscription to find the plan:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------- sessions
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
  const i = c.indexOf('=');
  const k = (i < 0 ? c : c.slice(0, i)).trim(), v = i < 0 ? '' : c.slice(i + 1).trim();
  try { return [k, decodeURIComponent(v)]; } catch (e) { return [k, v]; }
}).filter(([k]) => k));
const sessionTokenOf = req => cookies(req).pc_session || '';
const isHttps = req => String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';

/** The signed-in account, honouring expiry. Null for a visitor. */
function authAccount(req) {
  const t = sessionTokenOf(req);
  if (!t) return null;
  const s = one('SELECT * FROM sessions WHERE token = ?', t);
  if (!s) return null;
  if (s.expires_at && s.expires_at < new Date().toISOString()) { run('DELETE FROM sessions WHERE token = ?', t); return null; }
  return provision.accountById(s.account_id);
}

/** Open a session and return the Set-Cookie value for it. */
function openSession(req, accountId) {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  run('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,?,?)', token, accountId, new Date().toISOString(), expires);
  // Secure only over https, decided per request rather than by NODE_ENV, because a
  // Secure cookie set over plain http on localhost is silently dropped by the browser
  // and the developer spends an hour wondering why sign-in does nothing.
  return `pc_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${isHttps(req) ? '; Secure' : ''}`;
}
const CLEAR_COOKIE = 'pc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

/** Guard every state-changing request. Returns an error string, or null to proceed. */
function csrfProblem(req, form) {
  if (!originOk(req)) return 'That request appeared to come from another website, so it was refused.';
  if (!csrfValid(form && form._csrf, sessionTokenOf(req))) return 'Your session has expired or the form was stale. Please go back, reload the page and try again.';
  return null;
}

/**
 * Sign-in lockout, recorded in the database so restarting the server does not reset
 * an attacker's counter. Keyed on email plus caller address, so one attacker cannot
 * lock a real business manager out of their own account from elsewhere.
 */
const LOGIN_MAX_ATTEMPTS = 8, LOGIN_WINDOW_MIN = 15;
const loginLocked = id => (one('SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND at > ?', id, new Date(Date.now() - LOGIN_WINDOW_MIN * 60000).toISOString()).n) >= LOGIN_MAX_ATTEMPTS;
const recordFailedLogin = id => run('INSERT INTO login_attempts (identifier, at) VALUES (?,?)', id, new Date().toISOString());
const clearFailedLogins = id => run('DELETE FROM login_attempts WHERE identifier = ?', id);

/** Fixed-window rate limiter, keyed by caller. In memory is fine: it is a nuisance filter, not the lockout. */
function createRateLimiter({ limit, windowMs, maxKeys = 5000 }) {
  const hits = new Map();
  return { limit, check(key) {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (recent.length >= limit) return { limited: true };
    recent.push(now); hits.set(key, recent);
    if (hits.size > maxKeys) hits.clear();
    return { limited: false };
  } };
}
const callerKey = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
// Guessing a 256-bit setup token is not a realistic attack, and /welcome is only
// useful with a Stripe session id. Both are limited anyway: it costs nothing, and it
// stops a broken script or a bored crawler turning either page into a stream of
// Stripe API calls.
const welcomeLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60 * 1000 });
const setupLimiter = createRateLimiter({ limit: 12, windowMs: 15 * 60 * 1000 });

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
.nav form{display:inline;margin:0}
.linkbtn{background:none;border:0;padding:0;font:inherit;color:var(--ink-2);cursor:pointer}.linkbtn:hover{color:var(--ink)}
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
.field{margin:0 0 18px}.field>label{display:block;font-weight:600;font-size:.93rem;margin-bottom:6px}
.field input:not([type=checkbox]),.field select{width:100%}
.field .hint{font-size:.85rem;color:var(--ink-2);margin-top:5px}
.check{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;font-size:.95rem}
.check input{margin:5px 0 0;width:18px;height:18px;flex:none}
.check span{color:var(--ink-2);font-size:.86rem;display:block}
.formcard{max-width:640px}
fieldset{border:1px solid var(--line);border-radius:9px;padding:18px 20px 8px;margin:0 0 22px}
legend{font-weight:640;font-size:.92rem;padding:0 6px}
.note{font-size:.86rem;color:var(--ink-2)}
footer{padding:44px 0;color:var(--ink-2);font-size:.88rem}
.banner{padding:14px 18px;border-radius:8px;font-size:.92rem;margin:0 0 24px}
.banner.warn{background:#fff8ec;border:1px solid #f0dcb8;color:#6b4708}
.banner.ok{background:var(--accent-soft);border:1px solid #b9ddd0;color:#0a4a36}
.banner.err{background:#fdeceb;border:1px solid #f3c2bf;color:#7a1a14}
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
code{font-family:var(--mono);font-size:.9em}
@media(max-width:640px){.nav{display:none}section{padding:58px 0}.hero{padding:62px 0}}
`;

/**
 * Page shell. `ctx` is { account, tok } for a signed-in visitor, so the header can
 * show "Your schools" and a sign-out button instead of the marketing links. The
 * sign-out is a POST with a CSRF token because a link that ends a session is a
 * state change like any other.
 */
const shell = (title, body, desc = '', ctx = {}) => `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${ctx.noindex ? '<meta name="robots" content="noindex">' : ''}<style>${CSS}</style></head>
<body><a href="#main" class="skip">Skip to main content</a>
<header class="site"><div class="wrap">
  <a class="brand" href="/">Policy<span>Clock</span></a>
  <nav class="nav" aria-label="Main">${ctx.account
    ? `<a href="/app">Your schools</a><a href="/app/${esc(SEED[0].slug)}">Live demo</a><form method="POST" action="/logout">${csrfField(ctx.tok)}<button class="linkbtn" type="submit">Sign out</button></form>`
    : `<a href="/#how">How it works</a><a href="/#pricing">Pricing</a><a href="/app">Live demo</a><a href="/login">Sign in</a><a class="btn" href="/#pricing">Start free trial</a>`}</nav>
</div></header>
<main id="main">${body}</main>
<footer><div class="wrap"><p><strong>Policy Clock</strong> — statutory publishing deadlines for English schools, with the source next to every one.</p>
<p class="note">A compliance tracking tool, not legal advice. Requirements are re-derived from current DfE guidance and legislation; DfE's own consolidated policy list was withdrawn on 7 March 2024.</p>
<p class="note"><a href="/terms">Terms of service</a> · <a href="/privacy">Privacy notice</a> · Contact: ${SUPPORT}</p>
<p class="note">Policy Clock is a trading name of Keelson Holdings Ltd, registered in England and Wales, company number 17359226. Registered office: 71-75 Shelton Street, Covent Garden, London WC2H 9JQ.</p></div></footer></body></html>`;

const simplePage = (title, heading, html, ctx) => shell(`Policy Clock — ${title}`,
  `<section style="padding:52px 0"><div class="wrap" style="max-width:760px"><h2>${esc(heading)}</h2>${html}</div></section>`, '', ctx);

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
      <p>Fixed dates, annual reviews and three and four year cycles all tracked together, counted down day by day. Email reminders 45 days out — in time to reach a governors' meeting — are coming soon.</p></div>
    <div class="card"><span class="num">03</span><h3>Evidence, ready for the board</h3>
      <p>One click produces a dated summary showing what is published, what is late and what is coming, with sources. It is what you hand the governors, or Ofsted.</p></div>
  </div>
  <p class="note" style="margin-top:30px">"Must" and "should" are scored separately. Your compliance figure covers only what the law actually requires — DfE recommendations are tracked, but never inflate the number.</p>
</div></section>

<section id="pricing"><div class="wrap">
  <h2>Pricing</h2>
  <p class="lede">Less than an hour of a business manager's time each month.</p>
  <div class="price-grid">${tiers}</div>
  <p class="note" style="margin-top:24px">The price shown is the total payable. Keelson Holdings Ltd is not VAT registered, so no VAT is added and we cannot issue a VAT invoice. Billed monthly in pounds sterling; card handling by Stripe.</p>
  <p class="note">Setup is self-service and takes about two minutes: subscribe, name your school, choose a password, and your dashboard opens. Nothing is charged until the 30 day trial ends.</p>
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

// ---------------------------------------------------------------- onboarding pages
// This product sends no email. Not "not yet" — there is no transactional email
// provider wired up, and adding one is a separate decision about deliverability and
// who is accountable when a message lands in a school's spam filter. So the entire
// handover from a completed payment to a working sign-in happens on these pages, in
// the tab the customer already has open. If they cannot get from /welcome to a
// password, they cannot get in at all, and the only route left is emailing Oli —
// which is exactly the manual step this whole path exists to remove.

/**
 * Where Stripe returns a paying customer, with ?session_id={CHECKOUT_SESSION_ID}.
 *
 * Five states, because all five genuinely happen:
 *   ready       The account exists and has no password yet: here is the link.
 *   pending     Stripe redirected the browser and delivered the webhook at the same
 *               moment, the browser won, and we could not reach Stripe to fill the
 *               gap ourselves. Ordinary, harmless, resolves in seconds — so it must
 *               not look like a failure to somebody who has just handed over a card.
 *   done        They set a password already and came back here from history.
 *   unknown     A session id Stripe does not recognise as complete. Says nothing
 *               reassuring, because we have not confirmed a payment.
 *   no-session  Reached /welcome directly.
 *
 * There is deliberately no meta refresh on the pending state: an automatic refresh
 * is a WCAG 2.2.1 failure unless it can be turned off, and a product sold on
 * statutory compliance does not get to ship one on its own checkout page.
 */
function welcomePage({ state, account = null, setupUrl = null, sessionId = null }) {
  const again = sessionId ? `/welcome?session_id=${encodeURIComponent(sessionId)}` : '/welcome';
  const ctx = { noindex: true };
  if (state === 'ready' && account && setupUrl) {
    const plan = planById(account.plan);
    const limit = schoolLimitFor(account.plan);
    return simplePage('thank you', 'Thank you — one step left', `
      <div class="banner ok" role="status">Stripe has your card. Your 30 day trial has started; nothing is charged until it ends.</div>
      <p class="lede">Set up your school now. You will name it, tell us what kind of school it is, and choose a password. Your dashboard opens straight away — there is no waiting on us.</p>
      <p><a class="btn" href="${esc(setupUrl)}">Set up your school</a></p>
      <p class="note">This link works once and is only shown here, so it is worth doing now rather than later. If you lose it, come back to this page and it will issue a new one.</p>
      <p class="note">Your plan: <strong>${esc(plan ? plan.name : account.plan)}</strong> — ${limit == null ? 'no limit on the number of schools' : limit === 1 ? 'one school' : `up to ${limit} schools`}. ${limit === 1 ? '' : 'You add the first here and the rest from your dashboard.'}</p>
      <p class="note">Anything at all: <a href="mailto:${SUPPORT}">${SUPPORT}</a>. A real person answers, usually the same day.</p>`, ctx);
  }
  if (state === 'done' && account) {
    return simplePage('welcome', 'You are already set up', `
      <p class="lede">This account has a password, so there is nothing more to do here.</p>
      <p><a class="btn" href="/login">Sign in</a></p>
      <p class="note">If you did not set that password, or you cannot remember it, email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will reset it.</p>`, ctx);
  }
  if (state === 'pending') {
    return simplePage('setting up', 'Thank you — we are setting your account up', `
      <p class="lede">Your payment has gone through. Stripe sent you back here a moment before it finished telling us about it, which is normal and usually resolves within a few seconds.</p>
      <p><a class="btn" href="${esc(again)}">Reload this page</a></p>
      <p class="note">When it has landed, this page will show your setup link. Nothing is lost by waiting, and you have not been charged twice.</p>
      <p class="note">Still saying this after a few minutes? Email <a href="mailto:${SUPPORT}">${SUPPORT}</a> with the time you paid and we will finish it by hand. Please do not pay again.</p>`, ctx);
  }
  return simplePage('welcome', 'We could not find that order', `
    <p class="lede">This page confirms a new subscription, but there is no completed payment attached to the link you followed.</p>
    <p>If you have just paid, go back to the tab Stripe returned you to and reload it — the address includes an order reference we need. If you were only looking round, nothing has gone wrong and nothing has been charged.</p>
    <p><a class="btn ghost" href="/">Back to the start</a> &nbsp; <a class="btn ghost" href="/login">Sign in</a></p>
    <p class="note">If you think you have paid and this keeps appearing, email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will find it.</p>`, ctx);
}

/**
 * The school profile fields, shared by setup, add-a-school and settings. `v` is
 * either a school row or the raw form being re-shown after a validation error;
 * `fromForm` tells the checkboxes that an absent key means unticked rather than
 * "use the default".
 */
function schoolFields(v = {}, { fromForm = false } = {}) {
  const val = (k, d) => (v[k] === undefined || v[k] === null ? (fromForm ? '' : d) : v[k]);
  const on = (k, d) => { const x = v[k]; if (x === undefined || x === null) return fromForm ? '' : (d ? ' checked' : ''); return (x === 'on' || x === 1 || x === '1' || x === true) ? ' checked' : ''; };
  const sel = (k, opt, d) => (val(k, d) === opt ? ' selected' : '');
  return `
    <div class="field"><label for="f-name">School name</label>
      <input id="f-name" name="name" required maxlength="120" value="${esc(val('name', ''))}" autocomplete="organization"></div>
    <div class="field"><label for="f-website">School website</label>
      <input id="f-website" name="website" inputmode="url" placeholder="www.example.sch.uk" value="${esc(val('website', ''))}">
      <div class="hint">Optional. Where the published documents live.</div></div>
    <div class="field"><label for="f-type">Kind of school</label>
      <select id="f-type" name="type">
        <option value="maintained"${sel('type', 'maintained', 'maintained')}>Maintained (community, foundation, voluntary aided or controlled)</option>
        <option value="academy"${sel('type', 'academy', 'maintained')}>Academy or free school</option></select>
      <div class="hint">Decides which publishing regulations apply — for instance, only maintained schools must publish a complaints procedure.</div></div>
    <div class="field"><label for="f-phase">Phase</label>
      <select id="f-phase" name="phase">
        <option value="primary"${sel('phase', 'primary', 'primary')}>Primary</option>
        <option value="secondary"${sel('phase', 'secondary', 'primary')}>Secondary</option>
        <option value="all-through"${sel('phase', 'all-through', 'primary')}>All-through</option>
        <option value="special"${sel('phase', 'special', 'primary')}>Special</option></select>
      <div class="hint">Secondary and all-through schools carry the careers programme duty.</div></div>
    <div class="field"><label for="f-employees">Number of employees</label>
      <input id="f-employees" name="employees" inputmode="numeric" pattern="[0-9]*" value="${esc(val('employees', 50))}">
      <div class="hint">An estimate is fine. It only matters whether it is 250 or more, which switches on gender pay gap reporting.</div></div>
    <fieldset><legend>Which of these apply?</legend>
      <label class="check"><input type="checkbox" name="receives_pupil_premium"${on('receives_pupil_premium', true)}><div>Receives pupil premium<span>Adds the 31 December strategy statement deadline.</span></div></label>
      <label class="check"><input type="checkbox" name="receives_pe_premium"${on('receives_pe_premium', true)}><div>Receives PE and sport premium<span>Primary schools nearly always do. Adds the 31 July report deadline.</span></div></label>
      <label class="check"><input type="checkbox" name="own_admissions_authority"${on('own_admissions_authority', false)}><div>The school is its own admissions authority<span>Academies, foundation and voluntary aided schools are. Community and voluntary controlled schools are not — the local authority is. Adds the 15 March, 28 February and 31 August admissions deadlines.</span></div></label>
      <label class="check"><input type="checkbox" name="has_uniform"${on('has_uniform', true)}><div>Has a school uniform<span>Adds the (recommended, not statutory) uniform policy.</span></div></label>
    </fieldset>`;
}

/** Set up the first school and a password from a one-time link. */
function setupPage({ account, token, tok, values = {}, fromForm = false, error = null }) {
  const plan = planById(account.plan);
  return shell('Policy Clock — set up your school', `<section style="padding:52px 0"><div class="wrap formcard">
    <h2>Set up your school</h2>
    <p class="lede">Two minutes. Everything here can be changed later from your dashboard, except the password, which you can change by emailing us.</p>
    <p class="note">Plan: <strong>${esc(plan ? plan.name : account.plan)}</strong>${account.email ? ` · signing in as <strong>${esc(account.email)}</strong>` : ''}</p>
    ${error ? `<div class="banner err" role="alert">${esc(error)}</div>` : ''}
    <form method="POST" action="/setup/${encodeURIComponent(token)}">${csrfField(tok)}
      ${schoolFields(values, { fromForm })}
      <fieldset><legend>Your password</legend>
        <div class="field"><label for="f-pw">Choose a password</label>
          <input id="f-pw" name="password" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password">
          <div class="hint">At least ${MIN_PASSWORD_LENGTH} characters. Three or four unrelated words is the easiest thing to remember and the hardest thing to guess, for example <code>${esc(suggestPassword())}</code>.</div></div>
        <div class="field"><label for="f-pw2">Type it again</label>
          <input id="f-pw2" name="password2" type="password" required minlength="${MIN_PASSWORD_LENGTH}" autocomplete="new-password"></div>
      </fieldset>
      <p><button class="btn" type="submit">Open my dashboard</button></p>
    </form>
    <p class="note">This link works once. Afterwards you sign in at <a href="/login">/login</a> with the email you paid with and this password. We never see the password — only a scrypt hash is stored, which cannot be reversed, so we can reset it but never tell you what it was.</p>
  </div></section>`, '', { noindex: true });
}

/**
 * A setup link that cannot be used. One message covers expired, already used and
 * never existed — partly because once a token is burned we genuinely cannot tell
 * those apart, and partly because telling an unknown visitor which one it was
 * answers a question they have no business asking.
 */
const setupProblemPage = message => simplePage('that link cannot be used', 'That link cannot be used', `
  <div class="banner err" role="alert">${esc(message)}</div>
  <p><a class="btn ghost" href="/login">Sign in</a> if you have already set a password.</p>
  <p class="note">Otherwise email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will get you in. Please do not pay again.</p>`, { noindex: true });

function loginPage({ tok, error = null, email = '' }) {
  return shell('Policy Clock — sign in', `<section style="padding:52px 0"><div class="wrap" style="max-width:480px">
    <h2>Sign in</h2>
    ${error ? `<div class="banner err" role="alert">${esc(error)}</div>` : ''}
    <form method="POST" action="/login">${csrfField(tok)}
      <div class="field"><label for="l-email">Email address</label>
        <input id="l-email" name="email" type="email" required autocomplete="email" value="${esc(email)}" autofocus></div>
      <div class="field"><label for="l-pw">Password</label>
        <input id="l-pw" name="password" type="password" required autocomplete="current-password"></div>
      <p><button class="btn" type="submit">Sign in</button></p>
    </form>
    <p class="note">Just subscribed? Go back to the page Stripe returned you to after paying — your setup link is there. Forgotten your password? Email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will reset it.</p>
  </div></section>`, '', { noindex: true });
}

// ---------------------------------------------------------------- app
function picker() {
  return shell('Policy Clock — choose a school', `<section style="padding:52px 0"><div class="wrap">
    <h2>Demo schools</h2><p class="lede">Two seeded profiles. One is in reasonable shape; the other is a realistic mess.</p>
    <table><thead><tr><th>School</th><th>Type</th><th>Phase</th><th></th></tr></thead><tbody>
    ${SEED.map(s => `<tr><td><strong>${esc(s.name)}</strong><div class="note">${esc(s.note || '')}</div></td>
      <td>${esc(s.type)}</td><td>${esc(s.phase)}</td>
      <td><a class="btn sm" href="/app/${esc(s.slug)}">Open</a></td></tr>`).join('')}
    </tbody></table>
    <p class="note" style="margin-top:24px">Already a customer? <a href="/login">Sign in</a>. Not yet? <a href="/#pricing">Start a free 30 day trial</a>.</p></div></section>`);
}

/** Status banner for a signed-in account, shown on every page in the app. */
function accountBanner(account) {
  if (account.status === 'trialing') return `<div class="banner ok" role="status">Your 30 day free trial is running. Nothing is charged until it ends; cancel before then and you pay nothing.</div>`;
  if (account.status === 'cancelled') return `<div class="banner warn" role="status">Your subscription has ended, so this account is read-only. Nothing has been deleted. To start again, email <a href="mailto:${SUPPORT}">${SUPPORT}</a> and we will reconnect it.</div>`;
  return '';
}

/** The signed-in customer's list of schools, and the add-a-school gate. */
function mySchools(account, tok, flash) {
  const schools = provision.schoolsForAccount(account.id);
  const plan = planById(account.plan);
  const limit = schoolLimitFor(account.plan);
  const canAdd = account.status !== 'cancelled' && provision.canAddSchool(account);
  const used = limit == null ? `${schools.length} school${schools.length === 1 ? '' : 's'}, no limit` : `${schools.length} of ${limit} school${limit === 1 ? '' : 's'} used`;
  return shell('Policy Clock — your schools', `<section style="padding:52px 0"><div class="wrap">
    <h2>Your schools</h2>
    <p class="lede">${esc(plan ? plan.name : account.plan)} plan · ${esc(used)}${account.email ? ` · ${esc(account.email)}` : ''}</p>
    ${flash ? `<div class="banner ok" role="status">${esc(flash)}</div>` : ''}
    ${accountBanner(account)}
    ${schools.length ? `<table><thead><tr><th>School</th><th>Type</th><th>Phase</th><th></th></tr></thead><tbody>
      ${schools.map(s => `<tr><td><strong>${esc(s.name)}</strong>${s.website ? `<div class="note"><a href="${esc(s.website)}" rel="noopener">${esc(s.website)}</a></div>` : ''}</td>
        <td>${esc(s.type)}</td><td>${esc(s.phase)}</td>
        <td style="white-space:nowrap"><a class="btn sm" href="/app/${esc(s.slug)}">Open</a> <a class="btn sm ghost" href="/app/${esc(s.slug)}/settings">Settings</a></td></tr>`).join('')}
      </tbody></table>` : `<p>No schools yet.</p>`}
    <p style="margin-top:26px">${canAdd
      ? `<a class="btn" href="/app/new">Add a school</a>`
      : account.status === 'cancelled' ? ''
        : `<span class="note">Your ${esc(plan ? plan.name : account.plan)} plan covers ${limit === 1 ? 'one school' : `${limit} schools`} and you have used ${limit === 1 ? 'it' : 'them all'}. To move to a bigger plan, email <a href="mailto:${SUPPORT}">${SUPPORT}</a> — changing plans is not self-service yet.</span>`}</p>
  </div></section>`, '', { account, tok });
}

/** Add-a-school and settings share one form; `existing` tells them apart. */
function schoolFormPage({ account, tok, existing = null, values = null, fromForm = false, error = null }) {
  const editing = !!existing;
  const action = editing ? `/app/${encodeURIComponent(existing.slug)}/settings` : '/app/new';
  return shell(`Policy Clock — ${editing ? existing.name : 'add a school'}`, `<section style="padding:52px 0"><div class="wrap formcard">
    <p class="note"><a href="${editing ? `/app/${esc(existing.slug)}` : '/app'}">← ${editing ? 'Back to the dashboard' : 'Your schools'}</a></p>
    <h2>${editing ? `Settings — ${esc(existing.name)}` : 'Add a school'}</h2>
    ${editing ? '<p class="lede">Changing the kind of school, phase or the flags changes which deadlines the clock tracks. Dates you have already recorded are kept.</p>' : ''}
    ${error ? `<div class="banner err" role="alert">${esc(error)}</div>` : ''}
    <form method="POST" action="${action}">${csrfField(tok)}
      ${schoolFields(values || existing || {}, { fromForm })}
      <p><button class="btn" type="submit">${editing ? 'Save changes' : 'Add school'}</button></p>
    </form>
  </div></section>`, '', { account, tok });
}

const FLASH = {
  saved: 'Publication date recorded.',
  welcome: 'Welcome to Policy Clock. Record the date each item was last published and the clock does the rest. Check the profile in Settings if anything looks wrong.',
  created: 'School added.',
  updated: 'School details saved. Any deadlines that no longer apply have gone; any new ones are below.',
};

/**
 * The dashboard. `ctx` carries the signed-in account (if any), the session token
 * for CSRF fields, and readOnly for a cancelled account, whose record forms are
 * replaced by the recorded date.
 */
function dashboard(s, flash, ctx = {}) {
  const report = evaluate(s, loadState(s.slug), new Date());
  const bad = report.counts.failingMust > 0;
  const readOnly = !!ctx.readOnly;

  const row = r => `<tr>
    <td><span class="pill ${r.status}">${r.status.replace('_', ' ')}</span>
      <div style="margin-top:6px"><span class="pill ${r.force}">${r.force}</span></div></td>
    <td><strong>${esc(r.title)}</strong>
      <div class="detail">${esc(r.detail)}</div>
      ${r.action ? `<div class="act">→ ${esc(r.action)}</div>` : ''}
      <div class="src">${esc(r.source)}</div>
      ${r.provenanceWarning ? `<div class="note" style="color:var(--amber);margin-top:5px">Cycle length comes from guidance DfE has withdrawn — treat as convention, not law.</div>` : ''}</td>
    <td>${esc(r.message)}</td>
    <td>${readOnly ? esc(r.published_at || '—') : `<form class="rowform" method="POST" action="/app/${esc(s.slug)}/record">${csrfField(ctx.tok)}
      <input type="hidden" name="requirement_id" value="${esc(r.id)}">
      <label class="skip" for="d-${esc(r.id)}">Date published for ${esc(r.title)}</label>
      <input id="d-${esc(r.id)}" type="date" name="published_at" value="${esc(r.published_at || '')}" required>
      <button class="btn sm" type="submit">Save</button></form>`}</td></tr>`;

  const groups = [...new Set(report.results.map(r => r.group))];

  return shell(`Policy Clock — ${s.name}`, `<section style="padding:48px 0"><div class="wrap">
    <p class="note"><a href="/app">← ${s.demo ? 'All schools' : 'Your schools'}</a>${s.demo ? '' : ` · <a href="/app/${esc(s.slug)}/settings">Settings</a>`}</p>
    <h2>${esc(s.name)}</h2>
    <p class="lede">${esc(s.type)} · ${esc(s.phase)} · ${s.employees} employees${s.receives_pupil_premium ? ' · receives pupil premium' : ''}${s.own_admissions_authority ? ' · own admissions authority' : ''}${s.website ? ` · <a href="${esc(s.website)}" rel="noopener">website</a>` : ''}</p>
    ${s.demo ? '<div class="banner warn" role="status">This is a demo school. Anyone can record dates here and they are shared with every other visitor.</div>' : ''}
    ${ctx.error ? `<div class="banner err" role="alert">${esc(ctx.error)}</div>` : ''}
    ${flash ? `<div class="banner ok" role="status">${esc(flash)}</div>` : ''}
    ${ctx.account && !s.demo ? accountBanner(ctx.account) : ''}
    <div class="scorebox">
      <div><div class="big ${bad ? 'bad' : 'good'}">${report.score}%</div><div class="note">statutory compliance</div></div>
      <div><div class="big">${report.counts.failingMust}</div><div class="note">not compliant</div></div>
      <div><div class="big">${report.counts.dueSoon}</div><div class="note">due within 45 days</div></div>
      <div style="flex:1;min-width:220px"><strong>${esc(report.headline)}</strong>
        <div class="note" style="margin-top:6px">Score counts statutory "must" items only. ${report.counts.recommended} recommended items tracked separately.</div>
        <p style="margin:14px 0 0"><a class="btn sm" href="/app/${esc(s.slug)}/pack">Governors' evidence pack</a>
        <a class="btn sm ghost" href="/api/${esc(s.slug)}">JSON</a></p></div>
    </div>
    ${groups.map(g => `<h3 style="margin:34px 0 12px">${esc(g)}</h3>
      <table><caption class="skip">${esc(g)} requirements</caption><thead><tr>
      <th scope="col">Status</th><th scope="col">Requirement and source</th><th scope="col">Position</th><th scope="col">Date published</th>
      </tr></thead><tbody>${report.results.filter(r => r.group === g).map(row).join('')}</tbody></table>`).join('')}
  </div></section>`, '', ctx);
}

/**
 * Who may see a school. Demo schools: everyone. Customer schools: the account that
 * owns them, and nobody else — not even another signed-in customer. Returns the
 * school, or null for "no such school", or 'forbidden'.
 */
function accessibleSchool(slug, account) {
  const s = school(slug);
  if (!s) return null;
  if (s.demo) return s;
  if (account && s.account_id === account.id) return s;
  return 'forbidden';
}
const signInPage = (res, ctx) => send(res, 403, simplePage('sign in', 'Sign in to see this school',
  `<p class="lede">That school belongs to a Policy Clock customer. If it is yours, sign in.</p><p><a class="btn" href="/login">Sign in</a></p>`, ctx));

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = Object.fromEntries(url.searchParams);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, landing(q.subscribed ? 'Thanks — we will send your free check shortly.' : null));
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true,
        storage: { persistent: DB_PERSISTENT, location: DB_LOCATION,
          // Render's free tier has no disk: /tmp is wiped on every deploy and spin-down,
          // and every customer account with it. This flag is here so that is visible.
          ephemeral: !DB_PERSISTENT || /^\/tmp(\/|$)/.test(DB_LOCATION) || DB_LOCATION === ':memory:' },
        demo_schools: SEED.length, requirements: REQUIREMENTS.length });
    }
    if (req.method === 'GET' && url.pathname === '/terms') return send(res, 200, shell('Policy Clock — terms of service', TERMS));
    if (req.method === 'GET' && url.pathname === '/privacy') return send(res, 200, shell('Policy Clock — privacy notice', PRIVACY));

    // ── sign in / out ──────────────────────────────────────────────────────
    if (url.pathname === '/login') {
      const tok = sessionTokenOf(req);
      if (req.method === 'GET') return authAccount(req) ? redirect(res, '/app') : send(res, 200, loginPage({ tok }));
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
      const f = parseForm(await readBody(req));
      const bad = csrfProblem(req, f);
      if (bad) return send(res, 403, loginPage({ tok, error: bad, email: f.email }));
      const email = String(f.email || '').trim().toLowerCase().slice(0, 254);
      const lockKey = `${email}|${callerKey(req)}`;
      if (loginLocked(lockKey)) {
        console.warn(`[login] locked out: ${lockKey}`);
        return send(res, 429, loginPage({ tok, email, error: `Too many failed attempts. Please wait ${LOGIN_WINDOW_MIN} minutes and try again.` }));
      }
      // Always run at least one hash comparison, even for an unknown email, so the
      // response time does not reveal which addresses have accounts.
      const candidates = provision.accountsByEmail(email);
      let account = null;
      if (!candidates.length) verifyPassword(f.password, null);
      for (const c of candidates) if (verifyPassword(f.password, c.password_hash)) { account = c; break; }
      if (!account) {
        recordFailedLogin(lockKey);
        return send(res, 401, loginPage({ tok, email, error: 'That email and password were not recognised.' }));
      }
      clearFailedLogins(lockKey);
      return redirect(res, '/app', { 'Set-Cookie': openSession(req, account.id) });
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      const f = parseForm(await readBody(req));
      // A forged sign-out is only a nuisance, but the check is free and consistent.
      if (!csrfProblem(req, f)) { const t = sessionTokenOf(req); if (t) run('DELETE FROM sessions WHERE token = ?', t); }
      return redirect(res, '/', { 'Set-Cookie': CLEAR_COOKIE });
    }

    // ── the handover from paid to signed in ────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/welcome') {
      const sessionId = String(q.session_id || '');
      if (!sessionId) return send(res, 200, welcomePage({ state: 'no-session' }));
      if (welcomeLimiter.check(callerKey(req)).limited) return send(res, 429, welcomePage({ state: 'pending', sessionId }));
      // A Checkout Session id has one shape. Anything else is not worth a Stripe call.
      if (!/^cs_(test|live)_[A-Za-z0-9]{10,}$/.test(sessionId)) return send(res, 200, welcomePage({ state: 'unknown', sessionId }));

      // Our own database first. Once the webhook has landed this needs no call to
      // Stripe at all, so the page keeps working through a Stripe outage — which is
      // exactly when a customer is most likely to be reloading it.
      let account = provision.accountByStripeSession(sessionId);
      if (!account) {
        // Not provisioned yet. Ask Stripe whether this is a real, completed session.
        // If it is, provision from Stripe's copy of it right here rather than making
        // the customer reload until the webhook wins: Stripe's answer to a request
        // signed with our secret key is every bit as authoritative as a signed
        // webhook, provisioning is idempotent on the session id, and a customer who
        // has just handed over a card should not be told to wait for anything. An
        // invented or abandoned session id must never produce "thank you" though —
        // that is the 'unknown' state below.
        // `paid` is three-valued: true, false, or null for "could not ask". A Stripe
        // outage or a missing key is "cannot confirm", never "not paid", and gets
        // the calm pending page rather than "we could not find that order".
        let paid = null, sess = null;
        try {
          sess = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
          paid = sess.status === 'complete' || sess.payment_status === 'paid' || sess.payment_status === 'no_payment_required';
        } catch (err) {
          console.error('[welcome] could not retrieve the Checkout Session:', err.message);
        }
        if (paid) {
          try {
            const r = provision.provisionFromCheckoutSession(sess, { plan: await planForSession(sess) });
            if (r.ok) { account = r.account; console.log(`[provision] ${r.repeat ? 'already had' : 'created from /welcome'} account ${account.id} for ${sessionId}`); }
          } catch (err) { console.error('[welcome] provisioning from the retrieved session failed:', err); }
        }
        if (!account) return send(res, 200, welcomePage({ state: paid === false ? 'unknown' : 'pending', sessionId }));
      }
      if (account.password_hash) return send(res, 200, welcomePage({ state: 'done', account }));
      // No password yet, so they need a link that works. Re-issue if the old one has
      // expired: with no email to fall back on, the alternative is a school that has
      // paid, cannot sign in, and has nothing from us to click. Possession of the
      // Checkout Session id is what proves they are the buyer, and it is no weaker a
      // secret than the token it mints. Unreachable once a password exists, so it can
      // never take an account over.
      const existing = provision.accountBySetupToken(account.setup_token);
      const token = existing.ok ? account.setup_token : provision.reissueSetupToken(account.id);
      if (!token) return send(res, 200, welcomePage({ state: 'done', account }));
      return send(res, 200, welcomePage({ state: 'ready', account, setupUrl: `/setup/${encodeURIComponent(token)}`, sessionId }));
    }

    // First sign-in for an account that has just paid. One-time token, shown on
    // /welcome and nowhere else.
    if (parts[0] === 'setup') {
      if (setupLimiter.check(callerKey(req)).limited) {
        return send(res, 429, setupProblemPage('That is a lot of attempts from this connection in a short time. Please wait a few minutes and open your link again.'));
      }
      const token = parts[1] || '';
      const found = provision.accountBySetupToken(token);
      if (!found.ok) {
        return send(res, 410, setupProblemPage('This link has already been used, or it has expired. If you have already set a password, sign in below. If not, go back to the page Stripe returned you to after paying and use the link there — it will issue a fresh one.'));
      }
      const account = found.account;
      const tok = sessionTokenOf(req);
      if (req.method === 'GET') return send(res, 200, setupPage({ account, token, tok }));
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');

      const f = parseForm(await readBody(req));
      const bad = csrfProblem(req, f);
      if (bad) return send(res, 403, setupPage({ account, token, tok, values: f, fromForm: true, error: bad }));
      const parsed = provision.schoolFromForm(f);
      if (!parsed.ok) return send(res, 400, setupPage({ account, token, tok, values: f, fromForm: true, error: parsed.error }));
      const password = String(f.password || '');
      const problem = password.length < MIN_PASSWORD_LENGTH
        ? `Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters. Three or four unrelated words is the easiest way to get there.`
        : password.length > 200 ? 'That password is longer than we can store. Please use fewer than 200 characters.'
          : password !== String(f.password2 || '') ? 'The two passwords did not match. Please type them both again.' : null;
      if (problem) return send(res, 400, setupPage({ account, token, tok, values: f, fromForm: true, error: problem }));

      // School first, then password. If the school insert failed the token would
      // still be live and the form could simply be resubmitted; the other way round
      // would leave an account with a password and nothing to look at.
      const created = provision.createSchool(account.id, parsed.school);
      provision.completeSetup(account.id, hashPassword(password));
      console.log(`[setup] account ${account.id} set a password and created "${created.slug}" on the ${account.plan} plan.`);
      return redirect(res, `/app/${created.slug}?ok=welcome`, { 'Set-Cookie': openSession(req, account.id) });
    }

    // ── the app ────────────────────────────────────────────────────────────
    const account = authAccount(req);
    const tok = sessionTokenOf(req);
    const ctx = { account, tok };

    if (req.method === 'GET' && url.pathname === '/app') {
      return send(res, 200, account ? mySchools(account, tok, q.ok && FLASH[q.ok]) : picker());
    }

    if (parts[0] === 'app' && parts[1] === 'new' && !parts[2]) {
      if (!account) return redirect(res, '/login');
      const limit = schoolLimitFor(account.plan);
      const refuse = () => redirect(res, '/app');
      if (account.status === 'cancelled' || !provision.canAddSchool(account)) return refuse();
      if (req.method === 'GET') return send(res, 200, schoolFormPage({ account, tok }));
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
      const f = parseForm(await readBody(req));
      const bad = csrfProblem(req, f);
      if (bad) return send(res, 403, schoolFormPage({ account, tok, values: f, fromForm: true, error: bad }));
      const parsed = provision.schoolFromForm(f);
      if (!parsed.ok) return send(res, 400, schoolFormPage({ account, tok, values: f, fromForm: true, error: parsed.error }));
      // Re-checked after the form round-trip: two tabs can both have passed the gate above.
      if (!provision.canAddSchool(account)) return send(res, 403, schoolFormPage({ account, tok, values: f, fromForm: true, error: `Your plan covers ${limit} school${limit === 1 ? '' : 's'} and they are all in use.` }));
      const created = provision.createSchool(account.id, parsed.school);
      return redirect(res, `/app/${created.slug}?ok=created`);
    }

    if (req.method === 'GET' && parts[0] === 'app' && parts[1] && !parts[2]) {
      const s = accessibleSchool(parts[1], account);
      if (s === 'forbidden') return signInPage(res, ctx);
      if (!s) return send(res, 404, simplePage('not found', 'No such school', '<p><a href="/app">Back</a></p>', ctx));
      const flash = q.saved ? FLASH.saved : (q.ok && FLASH[q.ok]) || null;
      return send(res, 200, dashboard(s, flash, { ...ctx, readOnly: !s.demo && account.status === 'cancelled' }));
    }

    if (req.method === 'GET' && parts[0] === 'app' && parts[2] === 'pack') {
      const s = accessibleSchool(parts[1], account);
      if (s === 'forbidden') return send(res, 403, 'Sign in to see this school', 'text/plain');
      if (!s) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, governorsSummary(evaluate(s, loadState(s.slug), new Date())), 'text/plain; charset=utf-8');
    }

    if (req.method === 'POST' && parts[0] === 'app' && parts[2] === 'record') {
      const s = accessibleSchool(parts[1], account);
      if (s === 'forbidden') return signInPage(res, ctx);
      if (!s) return send(res, 404, 'Not found', 'text/plain');
      const f = parseForm(await readBody(req));
      const bad = csrfProblem(req, f);
      if (bad) return send(res, 403, dashboard(s, null, { ...ctx, error: bad }));
      if (!s.demo && account.status === 'cancelled') return send(res, 403, dashboard(s, null, { ...ctx, readOnly: true, error: 'This account is read-only because its subscription has ended.' }));
      const req_ = REQUIREMENTS.find(r => r.id === f.requirement_id);
      if (!req_ || !applicable(req_, s)) return send(res, 400, dashboard(s, null, { ...ctx, error: 'That requirement does not apply to this school.' }));
      if (!validDate(f.published_at)) return send(res, 400, dashboard(s, null, { ...ctx, error: 'That date did not parse. Use YYYY-MM-DD.' }));
      run(`INSERT INTO publications (school_slug,requirement_id,published_at,url,recorded_at) VALUES (?,?,?,?,?)
        ON CONFLICT(school_slug,requirement_id) DO UPDATE SET published_at=excluded.published_at, recorded_at=excluded.recorded_at`,
        s.slug, f.requirement_id, f.published_at, nz(f.url), new Date().toISOString());
      return redirect(res, `/app/${s.slug}?saved=1`);
    }

    if (parts[0] === 'app' && parts[2] === 'settings' && !parts[3]) {
      if (!account) return redirect(res, '/login');
      const s = accessibleSchool(parts[1], account);
      if (!s || s === 'forbidden' || s.demo) return send(res, 404, simplePage('not found', 'No such school', '<p><a href="/app">Back</a></p>', ctx));
      if (req.method === 'GET') return send(res, 200, schoolFormPage({ account, tok, existing: s }));
      if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
      const f = parseForm(await readBody(req));
      const bad = csrfProblem(req, f);
      if (bad) return send(res, 403, schoolFormPage({ account, tok, existing: s, values: f, fromForm: true, error: bad }));
      if (account.status === 'cancelled') return send(res, 403, schoolFormPage({ account, tok, existing: s, values: f, fromForm: true, error: 'This account is read-only because its subscription has ended.' }));
      const parsed = provision.schoolFromForm(f);
      if (!parsed.ok) return send(res, 400, schoolFormPage({ account, tok, existing: s, values: f, fromForm: true, error: parsed.error }));
      provision.updateSchool(s.id, account.id, parsed.school);
      return redirect(res, `/app/${s.slug}?ok=updated`);
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] && !parts[2]) {
      const s = accessibleSchool(parts[1], account);
      if (s === 'forbidden') return json(res, 403, { error: 'sign in to see this school' });
      if (!s) return json(res, 404, { error: 'no such school' });
      return json(res, 200, evaluate(s, loadState(s.slug), new Date()));
    }

    // ── marketing forms ────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/subscribe') {
      const f = parseForm(await readBody(req));
      if (!validEmail(f.email)) return send(res, 400, landing('That email address did not look right — please try again.'));
      const row = { email: f.email.trim().toLowerCase(), school: f.school || null, role: f.role || null, created_at: new Date().toISOString() };
      let isNew = true;
      try {
        run('INSERT INTO waitlist (email,school,role,created_at) VALUES (?,?,?,?)', row.email, row.school, row.role, row.created_at);
      } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; isNew = false; }
      if (isNew) {
        fs.appendFileSync(path.join(DATA, 'waitlist.jsonl'), JSON.stringify(row) + '\n');
        // Also to stdout: on hosts with ephemeral disks (Render free tier), the
        // platform log stream is the durable record of sign-ups.
        console.log('[signup]', JSON.stringify(row));
      }
      return redirect(res, '/?subscribed=1#waitlist');
    }

    if (req.method === 'POST' && url.pathname === '/checkout') {
      const f = parseForm(await readBody(req));
      const tier = PRICING.find(t => t.id === f.tier);
      if (!tier) return send(res, 400, shell('Unknown plan', '<section><div class="wrap"><h2>Unknown plan</h2><p><a href="/#pricing">Back</a></p></div></section>'));
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!/^sk_(test|live)_/.test(key)) {
        return send(res, 200, shell('Stripe not configured', `<section><div class="wrap">
          <h2>Checkout is wired up, but not keyed</h2>
          <div class="banner warn">No <code>STRIPE_SECRET_KEY</code> beginning <code>sk_test_</code> or <code>sk_live_</code> is set, so nothing was sent to Stripe.</div>
          <p>Selected plan: <strong>${esc(tier.name)} — £${tier.price}/month</strong>.</p>
          <p><code style="font-family:var(--mono);font-size:.88rem">STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_${esc(tier.id.toUpperCase())}=price_... node server.js</code></p>
          <p>See <strong>SETUP.md</strong>. Never commit a live key.</p>
          <p><a class="btn ghost" href="/#pricing">Back to pricing</a></p></div></section>`));
      }
      const price = process.env[`STRIPE_PRICE_${tier.id.toUpperCase()}`];
      if (!price) return send(res, 500, shell('Missing price', `<section><div class="wrap"><h2>Missing price ID</h2><p>Set <code>STRIPE_PRICE_${esc(tier.id.toUpperCase())}</code>.</p></div></section>`));
      // Build return URLs from the actual request host so this works wherever it is
      // deployed (localhost, onrender.com, custom domain) without configuration.
      const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
      const base = `${proto}://${req.headers.host}`;
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
          success_url: `${base}/welcome?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/#pricing`,
          'subscription_data[trial_period_days]': '30',
          'subscription_data[metadata][tier]': tier.id,
          // The plan on the session itself as well as on the subscription, because
          // checkout.session.completed carries the session and not the subscription,
          // and provisioning needs to know what was bought without a second API call.
          client_reference_id: tier.id,
          'metadata[tier]': tier.id,
          // UK-only product: show the price we advertise, in pounds. Without these
          // two, Stripe's Adaptive Pricing converts to the visitor's local currency
          // and a UK school sees US dollars — and Managed Payments has to be switched
          // off in the same call or Stripe rejects the session outright.
          // See lib/checkout-note.md.
          'managed_payments[enabled]': 'false',
          'adaptive_pricing[enabled]': 'false' }),
      });
      const sess = await r.json();
      if (!r.ok) return send(res, 502, shell('Stripe error', `<section><div class="wrap"><h2>Stripe rejected that</h2><pre>${esc(JSON.stringify(sess.error || sess, null, 2))}</pre></div></section>`));
      return redirect(res, sess.url);
    }

    // ── Stripe webhook ─────────────────────────────────────────────────────
    // Verifies the signature itself, then provisions. The customers.jsonl append and
    // the [paid] log line are kept as the durable, human-readable backup: Render's
    // disk is ephemeral and the log stream is what Oli can reconstruct from.
    if (req.method === 'POST' && url.pathname === '/stripe/webhook') {
      const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
      const raw = await readBody(req);
      if (!/^whsec_/.test(secret)) {
        console.error('[webhook] STRIPE_WEBHOOK_SECRET is not set — event received and NOT recorded.');
        return json(res, 503, { error: 'webhook secret not configured' });
      }
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) {
        console.error('[webhook] bad signature — ignored.');
        return json(res, 400, { error: 'bad signature' });
      }
      let event;
      try { event = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (!['checkout.session.completed', 'invoice.paid', 'customer.subscription.deleted'].includes(event.type)) return json(res, 200, { received: true });

      const o = (event.data && event.data.object) || {};
      const record = { at: new Date().toISOString(), event: event.type, id: o.id || null,
        customer: o.customer || null, subscription: o.subscription || (o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) || null,
        email: (o.customer_details && o.customer_details.email) || o.customer_email || null,
        tier: (o.metadata && o.metadata.tier) || o.client_reference_id || null,
        amount: o.amount_total != null ? o.amount_total : (o.amount_paid != null ? o.amount_paid : null),
        currency: o.currency || null };
      try { fs.appendFileSync(path.join(DATA, 'customers.jsonl'), JSON.stringify(record) + '\n'); }
      catch (e) { console.error('[webhook] could not append to customers.jsonl:', e.message); }
      console.log('[paid]', JSON.stringify(record));

      try {
        if (event.type === 'checkout.session.completed') {
          const r = provision.provisionFromCheckoutSession(o, { plan: await planForSession(o) });
          if (!r.ok) console.error(`[provision] could not provision from ${o.id || 'a session with no id'}: ${r.reason}. This one needs a human.`);
          else if (r.repeat) console.log(`[provision] account ${r.account.id} already exists for ${o.id} — repeat delivery, nothing to do.`);
          else console.log(`[provision] account ${r.account.id} created on the ${r.account.plan} plan for ${r.account.email || 'an unknown address'}. Setup link is on /welcome.`);
        } else if (event.type === 'invoice.paid') {
          // Stripe raises a £0 invoice the moment a trial starts and marks it paid.
          // That is not a payment, and an account must not read as 'active' until
          // real money has moved — it is what 'trialing' is for.
          if ((o.amount_paid || 0) > 0) {
            const r = provision.activateBySubscription(record.subscription);
            if (r.ok) console.log(`[provision] account ${r.account.id} is ${r.account.status}${r.repeat ? ' (already)' : ''}.`);
            else console.warn(`[provision] invoice.paid for subscription ${record.subscription || 'with no id'} matched no account (${r.reason}).`);
          } else console.log(`[provision] £0 invoice for subscription ${record.subscription || '?'} — trial start, status unchanged.`);
        } else if (event.type === 'customer.subscription.deleted') {
          const r = provision.cancelBySubscription(o.id);
          if (r.ok) console.log(`[provision] account ${r.account.id} marked cancelled. Its schools and every recorded date are untouched.`);
          else console.warn(`[provision] cancellation for subscription ${o.id || 'with no id'} matched no account (${r.reason}).`);
        }
      } catch (err) {
        // Answer 5xx so Stripe retries. Provisioning is idempotent, so a retry after
        // a half-finished attempt is safe; a 200 here would throw the event away and
        // leave a school that has paid with no account and nothing but a log line.
        console.error(`[webhook] ${event.type} threw — returning 500 so Stripe retries:`, err);
        return json(res, 500, { error: 'handler-failed' });
      }
      return json(res, 200, { received: true });
    }

    return send(res, 404, simplePage('not found', 'Not found', '<p><a href="/">Back to the start</a></p>', ctx));
  } catch (err) {
    console.error(err);
    return send(res, 500, shell('Something broke', `<section><div class="wrap"><h2>Something broke</h2><pre>${esc(err.message)}</pre></div></section>`));
  }
});

if (require.main === module) {
  purgeExpired();
  setInterval(purgeExpired, 60 * 60 * 1000).unref();
  server.listen(PORT, () => {
    console.log(`Policy Clock on http://localhost:${PORT}`);
    console.log(`[storage] ${DB_LOCATION}${DB_PERSISTENT ? '' : ' (in memory)'}`);
    if (!DB_PERSISTENT || /^\/tmp(\/|$)/.test(DB_LOCATION)) {
      console.warn('[storage] ##########################################################################');
      console.warn('[storage] # This database does not survive a restart. Customer accounts, schools   #');
      console.warn('[storage] # and recorded dates created since the last deploy will be lost on the   #');
      console.warn('[storage] # next one. Attach a persistent disk and point CLOCK_DB at it.           #');
      console.warn('[storage] ##########################################################################');
    }
    if (SECRET_IS_EPHEMERAL) console.warn('[auth] SESSION_SECRET is not set: forms already open when this process restarts will need a reload. Set it in Render.');
  });
}
module.exports = { server, PRICING, landing };
