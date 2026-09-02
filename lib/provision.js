'use strict';
/**
 * Provisioning: turning a paid Stripe Checkout Session into an account a school
 * business manager can actually sign in to, and the schools that hang off it.
 *
 * Until 2 September 2026 the webhook handler wrote a console.log and a human added
 * the school by hand "normally within one working day". That is fine at zero
 * customers and a broken promise at one, because somebody pays at nine o'clock on a
 * Sunday evening and then waits.
 *
 * Ported from parish-in-a-box/lib/provision.js, which solved the same problem the day
 * before. One structural difference: Parish has one council per payment, so the
 * council row is the account. Policy Clock sells Federation (up to five schools) and
 * Trust (six or more), so here the payment creates an ACCOUNT and the schools are
 * separate rows that belong to it. The account is what has the Stripe ids, the
 * password and the setup token; the first school is created on the setup page, where
 * the customer tells us its name and what kind of school it is — Checkout never asked.
 *
 * Three things this module has to get right. All three look fine on a laptop and only
 * show up once real money moves:
 *
 *   1. IDEMPOTENCY. Stripe retries a webhook until it gets a 2xx, so the same
 *      checkout.session.completed arrives more than once as normal operation, not as
 *      a fault. Two accounts for one payment would mean two setup links and, later,
 *      two schools on one invoice. The Checkout Session id is the key, and the UNIQUE
 *      index in lib/db.js is what enforces it — the SELECT below is an optimisation,
 *      not the guarantee.
 *
 *   2. SLUGS. A school's slug is in its URL (/app/<slug>) and in every row of the
 *      publications table, so it has to be right first time: unique without throwing,
 *      sanitised, never one of the words the router reserves, and never one of the
 *      two demo schools.
 *
 *   3. NOT DELETING ANYTHING. A cancelled subscription marks the account cancelled
 *      and stops there. It never removes a school's publication record.
 */
const { randomBytes } = require('crypto');
const { one, q, run } = require('./db');
const { PLAN_IDS, DEFAULT_PLAN, schoolLimitFor } = require('./plans');

/**
 * How long a setup link stays valid. Fourteen days rather than the usual hour or
 * two, because the buyer is often a business manager who pays on a Friday and does
 * not open the laptop again until the following week. The link is single use and
 * only ever reaches one person, and /welcome will issue a fresh one anyway while the
 * account is unclaimed, so a long window costs little.
 */
const SETUP_TOKEN_DAYS = 14;

/**
 * Slugs the router would swallow. /app/<slug> shares its shape with /app/new, so a
 * school slugged "new" would have its dashboard served by the add-a-school handler —
 * baffling to diagnose and impossible for the customer to work around. The rest are
 * top-level routes today or obvious candidates tomorrow.
 */
const RESERVED_SLUGS = new Set([
  'new', 'app', 'api', 'login', 'logout', 'setup', 'welcome', 'checkout', 'subscribe',
  'stripe', 'health', 'terms', 'privacy', 'settings', 'pack', 'record', 'admin', 'demo',
]);

/** The two demo schools in data/schools.json. A customer can never take their slug. */
const DEMO_SLUGS = new Set(require('../data/schools.json').map(s => s.slug));

/** What lib/requirements.js distinguishes. Anything else is refused at the form. */
const SCHOOL_TYPES = ['maintained', 'academy'];
const PHASES = ['primary', 'secondary', 'all-through', 'special'];

const nz = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Stripe returns bare ids by default and whole objects when a field is expanded. */
const idOf = v => (v && typeof v === 'object' ? nz(v.id) : nz(v));

/** Cryptographically random, URL-safe, and long enough that guessing is not a threat. */
const newSetupToken = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------- slugs

/**
 * Reduce a school name to the [a-z0-9-] a URL can carry.
 *
 * NFKD splits an accented letter into a plain letter plus a combining mark, and
 * \p{M} then drops the mark, so "St Mary's C of E Académie" survives however it was
 * spelled. Doing it the other way round matters: without the decomposition step the
 * accented letter is not in [a-z0-9] and would become a hyphen, turning one word
 * into two.
 */
function slugify(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');                    // slice() can leave a trailing hyphen behind
}

const slugTaken = slug => DEMO_SLUGS.has(slug) || !!one('SELECT id FROM schools WHERE slug = ?', slug);

/**
 * A slug nobody else has.
 *
 * De-duplicates with a numeric suffix rather than letting the UNIQUE constraint
 * throw. Throwing here would mean a customer who has just been charged gets a 500
 * and no school, purely because another school in another county happens to share a
 * name — and there are a great many St Mary's and All Saints in England.
 *
 * isTaken is injectable so the de-duplication can be tested without a database.
 */
function uniqueSlug(desired, { isTaken = slugTaken } = {}) {
  let root = slugify(desired) || 'school';
  if (RESERVED_SLUGS.has(root)) root = `${root}-school`;
  if (!isTaken(root)) return root;
  for (let n = 2; n <= 1000; n++) {
    const candidate = `${root}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  // A thousand schools sharing one name is not a real scenario, but returning
  // something guaranteed unique beats throwing at the moment somebody has just paid.
  return `${root}-${randomBytes(5).toString('hex')}`;
}

// ---------------------------------------------------------------- reading a Checkout Session

/** The email Stripe collected, whichever field it landed in. */
const emailFromSession = session =>
  nz(session && session.customer_details && session.customer_details.email) || nz(session && session.customer_email);

/**
 * Which plan was bought, or null if the session does not say.
 *
 * /checkout stamps the plan id into client_reference_id and metadata.tier on the
 * session itself from 2 September 2026. Before that it only went on the subscription
 * (subscription_data[metadata][tier]), which the session object does not carry — so
 * server.js fetches the subscription and passes its metadata in for those. The
 * expanded-subscription shape is read here too, in case anyone ever expands it.
 */
function planFromSession(session) {
  const s = session || {};
  const claims = [
    s.client_reference_id,
    s.metadata && s.metadata.tier,
    s.metadata && s.metadata.plan,
    s.subscription && typeof s.subscription === 'object' && s.subscription.metadata && s.subscription.metadata.tier,
  ];
  for (const c of claims) {
    const v = nz(c);
    if (v && PLAN_IDS.has(v)) return v;
  }
  return null;
}

const accountById = id => one('SELECT * FROM accounts WHERE id = ?', id);
const accountByStripeSession = sessionId => one('SELECT * FROM accounts WHERE stripe_session_id = ?', sessionId);
const accountBySubscription = subscriptionId => one('SELECT * FROM accounts WHERE stripe_subscription_id = ?', subscriptionId);

// ---------------------------------------------------------------- provisioning

/**
 * Create the account for a completed Checkout Session.
 *
 * Returns { ok, repeat, account, setupToken } — never throws for anything the caller
 * can do something about. `repeat: true` means this session had already been
 * provisioned, which is the expected outcome of a Stripe retry and must be answered
 * with a 200, not an error.
 *
 * `plan` lets the caller pass a plan it resolved elsewhere (from the subscription's
 * metadata). If neither that nor the session names a known plan, the account lands
 * on the cheapest one and the log says so loudly: a customer paying £149 and getting
 * the £39 plan is a real problem that must not pass silently, but it is a support
 * email, whereas refusing to provision is a broken promise.
 */
function provisionFromCheckoutSession(session, { plan = null, now = new Date() } = {}) {
  const sessionId = idOf(session && session.id);
  if (!sessionId) return { ok: false, reason: 'no-session-id' };

  const subscriptionId = idOf(session.subscription);

  // Cheap path: we have seen this one. Checked on the subscription id as well as the
  // session id, because a subscription can only belong to one account and matching
  // either means the work is already done.
  const already = accountByStripeSession(sessionId)
    || (subscriptionId ? accountBySubscription(subscriptionId) : null);
  if (already) return { ok: true, repeat: true, account: already };

  let chosen = (plan && PLAN_IDS.has(plan)) ? plan : planFromSession(session);
  if (!chosen) {
    console.error(`[provision] Checkout Session ${sessionId} carries no recognisable plan — falling back to "${DEFAULT_PLAN}". Check this account's plan by hand.`);
    chosen = DEFAULT_PLAN;
  }

  const token = newSetupToken();
  const expires = new Date(now.getTime() + SETUP_TOKEN_DAYS * 86400000).toISOString();

  try {
    run(`INSERT INTO accounts
         (email, plan, status, created_at, stripe_session_id, stripe_customer_id, stripe_subscription_id,
          setup_token, setup_token_expires)
         VALUES (?,?,'trialing',?,?,?,?,?,?)`,
      emailFromSession(session), chosen, now.toISOString(), sessionId, idOf(session.customer), subscriptionId,
      token, expires);
  } catch (err) {
    // Losing the race against a concurrent delivery of the same event is the correct
    // outcome, not an error: the UNIQUE index did exactly its job. Any other failure
    // is real and must surface, so that Stripe retries.
    const raced = accountByStripeSession(sessionId)
      || (subscriptionId ? accountBySubscription(subscriptionId) : null);
    if (raced) return { ok: true, repeat: true, account: raced };
    throw err;
  }

  return { ok: true, repeat: false, account: accountByStripeSession(sessionId), setupToken: token };
}

/**
 * Mark an account active when a real invoice is paid.
 *
 * The caller decides what "real" means (server.js ignores the £0 invoice Stripe
 * raises when a trial starts). Cancelled is sticky: events can arrive out of order,
 * and an invoice.paid that turns up after customer.subscription.deleted must not
 * resurrect a subscription Stripe has already ended.
 */
function activateBySubscription(subscription) {
  const subscriptionId = idOf(subscription);
  if (!subscriptionId) return { ok: false, reason: 'no-subscription-id' };
  const account = accountBySubscription(subscriptionId);
  if (!account) return { ok: false, reason: 'unknown-subscription' };
  if (account.status === 'active' || account.status === 'cancelled') return { ok: true, repeat: true, account };
  run("UPDATE accounts SET status = 'active' WHERE id = ?", account.id);
  return { ok: true, repeat: false, account: accountById(account.id) };
}

/**
 * Mark an account cancelled when its subscription ends.
 *
 * Note what this does not do. It does not delete the account, its schools, or a
 * single publication date. A school's compliance record is evidence it may need to
 * show governors or Ofsted long after it stopped paying us, and a school that comes
 * back needs it all to still be there. server.js makes a cancelled account read-only.
 */
function cancelBySubscription(subscription) {
  const subscriptionId = idOf(subscription);
  if (!subscriptionId) return { ok: false, reason: 'no-subscription-id' };
  const account = accountBySubscription(subscriptionId);
  if (!account) return { ok: false, reason: 'unknown-subscription' };
  if (account.status === 'cancelled') return { ok: true, repeat: true, account };
  run("UPDATE accounts SET status = 'cancelled' WHERE id = ?", account.id);
  return { ok: true, repeat: false, account: accountById(account.id) };
}

// ---------------------------------------------------------------- setup tokens

/**
 * Look up an unexpired, unused setup token.
 *
 * Returns { ok: true, account } or { ok: false, reason }. "Unused" needs no separate
 * flag: completeSetup clears the token, so a used token simply is not found. The
 * caller must not tell the visitor which of missing, unknown and expired it was.
 */
function accountBySetupToken(token, { now = new Date() } = {}) {
  const t = nz(token);
  if (!t) return { ok: false, reason: 'missing' };
  const account = one('SELECT * FROM accounts WHERE setup_token = ?', t);
  if (!account) return { ok: false, reason: 'unknown' };
  if (!account.setup_token_expires || account.setup_token_expires < now.toISOString()) {
    return { ok: false, reason: 'expired', account };
  }
  // A token that somehow outlived the password it was meant to create is spent.
  if (account.password_hash) return { ok: false, reason: 'already-used', account };
  return { ok: true, account };
}

/**
 * Set the password and burn the token, in that order and in one statement, so there
 * is no instant at which the account has a password and a live setup link at once.
 */
function completeSetup(accountId, passwordHash) {
  run('UPDATE accounts SET password_hash = ?, setup_token = NULL, setup_token_expires = NULL WHERE id = ?',
    passwordHash, accountId);
  return accountById(accountId);
}

/**
 * Issue a fresh setup token for an account that still has no password.
 *
 * This exists because there is no email in this product. If a token expires before
 * the customer gets to it, the alternative to re-issuing is an account that has
 * paid, cannot sign in, and has nothing from us to click — which is precisely the
 * manual-intervention hole all of this is meant to close.
 *
 * Refuses once a password exists, so it can never be used to take an account over.
 * The caller must already have proved possession of the Checkout Session id.
 */
function reissueSetupToken(accountId, { now = new Date() } = {}) {
  const account = accountById(accountId);
  if (!account || account.password_hash) return null;
  const token = newSetupToken();
  run('UPDATE accounts SET setup_token = ?, setup_token_expires = ? WHERE id = ?',
    token, new Date(now.getTime() + SETUP_TOKEN_DAYS * 86400000).toISOString(), accountId);
  return token;
}

/**
 * Accounts that can sign in with this email, newest first. Email is not unique on
 * purpose: the same business manager can buy twice (two federations, a mistake, a
 * re-subscription) and the second payment must never fail to provision because of
 * the first. The login handler tries each; there are never more than a handful.
 */
const accountsByEmail = email =>
  q('SELECT * FROM accounts WHERE lower(email) = lower(?) AND password_hash IS NOT NULL ORDER BY id DESC', nz(email) || '');

// ---------------------------------------------------------------- schools

const schoolsForAccount = accountId => q('SELECT * FROM schools WHERE account_id = ? ORDER BY id', accountId);
const schoolBySlug = slug => one('SELECT * FROM schools WHERE slug = ?', slug);
const schoolCount = accountId => one('SELECT COUNT(*) AS n FROM schools WHERE account_id = ?', accountId).n;

/** Whether the plan's limit leaves room for one more. This is the enforcement. */
function canAddSchool(account) {
  const limit = schoolLimitFor(account.plan);
  if (limit == null) return true;
  return schoolCount(account.id) < limit;
}

/**
 * Validate and normalise the school form. Returns { ok: true, school } with exactly
 * the columns createSchool and updateSchool write, or { ok: false, error } with a
 * sentence fit to show the person who typed it.
 *
 * Every attribute here is one lib/requirements.js reads. There is no "term dates"
 * or similar: the register's deadlines are fixed calendar dates and review cycles,
 * not term-dependent, so nothing else needs capturing for the clock to be right.
 */
function schoolFromForm(f) {
  const form = f || {};
  const name = nz(form.name);
  if (!name || name.length < 2) return { ok: false, error: 'Please give the school a name.' };
  if (name.length > 120) return { ok: false, error: 'That name is longer than we can store — please shorten it to 120 characters.' };

  let website = nz(form.website);
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    try {
      const u = new URL(website);
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.') || u.username || u.password) throw new Error('bad');
      website = u.href;
    } catch (e) {
      return { ok: false, error: 'That website address did not look right. Something like www.example.sch.uk is fine.' };
    }
    if (website.length > 300) return { ok: false, error: 'That website address is too long.' };
  }

  const type = nz(form.type);
  if (!SCHOOL_TYPES.includes(type)) return { ok: false, error: 'Please choose whether the school is a maintained school or an academy.' };
  const phase = nz(form.phase);
  if (!PHASES.includes(phase)) return { ok: false, error: 'Please choose the school\'s phase.' };

  const employees = Number.parseInt(String(form.employees == null ? '' : form.employees).replace(/[,\s]/g, ''), 10);
  if (!Number.isFinite(employees) || employees < 0 || employees > 100000) {
    return { ok: false, error: 'Please give the number of employees as a whole number. An estimate is fine — it only matters whether it is 250 or more.' };
  }

  // Unchecked checkboxes are simply absent from a form post, so absent means 0.
  const flag = k => (form[k] === 'on' || form[k] === '1' || form[k] === 1 || form[k] === true || form[k] === 'true') ? 1 : 0;
  return {
    ok: true,
    school: {
      name, website, type, phase, employees,
      receives_pupil_premium: flag('receives_pupil_premium'),
      receives_pe_premium: flag('receives_pe_premium'),
      own_admissions_authority: flag('own_admissions_authority'),
      has_uniform: flag('has_uniform'),
    },
  };
}

/** Insert a school for an account. `school` must have come from schoolFromForm. */
function createSchool(accountId, school, { now = new Date() } = {}) {
  const slug = uniqueSlug(school.name);
  run(`INSERT INTO schools
       (account_id, slug, name, website, type, phase, employees,
        receives_pupil_premium, receives_pe_premium, own_admissions_authority, has_uniform, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    accountId, slug, school.name, school.website, school.type, school.phase, school.employees,
    school.receives_pupil_premium, school.receives_pe_premium, school.own_admissions_authority, school.has_uniform,
    now.toISOString());
  return schoolBySlug(slug);
}

/**
 * Update a school's profile. The slug is deliberately not editable: it keys every
 * publication date the school has recorded. Scoped to the account so a stale form
 * can never write to somebody else's school.
 */
function updateSchool(schoolId, accountId, school) {
  run(`UPDATE schools SET name=?, website=?, type=?, phase=?, employees=?,
       receives_pupil_premium=?, receives_pe_premium=?, own_admissions_authority=?, has_uniform=?
       WHERE id = ? AND account_id = ?`,
    school.name, school.website, school.type, school.phase, school.employees,
    school.receives_pupil_premium, school.receives_pe_premium, school.own_admissions_authority, school.has_uniform,
    schoolId, accountId);
  return one('SELECT * FROM schools WHERE id = ?', schoolId);
}

module.exports = {
  SETUP_TOKEN_DAYS, RESERVED_SLUGS, SCHOOL_TYPES, PHASES,
  newSetupToken, slugify, uniqueSlug,
  emailFromSession, planFromSession,
  accountById, accountByStripeSession, accountBySubscription, accountsByEmail,
  provisionFromCheckoutSession, activateBySubscription, cancelBySubscription,
  accountBySetupToken, completeSetup, reissueSetupToken,
  schoolsForAccount, schoolBySlug, schoolCount, canAddSchool, schoolFromForm, createSchool, updateSchool,
};
