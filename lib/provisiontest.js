'use strict';
/**
 * Tests for provisioning, setup tokens, slugs, plan limits and the auth primitives.
 * Run with: npm test
 *
 * The claim being tested: a completed Stripe payment becomes exactly one account
 * that exactly one person can sign in to, a Stripe retry does not change that, and
 * a plan's school limit is what the code enforces. Everything below is something
 * that would only show up in production, with somebody's money already taken.
 *
 * These run against a throwaway database in the system temp directory, never
 * data/clock.db. lib/db.js reads CLOCK_DB the moment it is required, so the variable
 * is set before the first require. Same convention as parish-in-a-box's tests, in
 * CommonJS because this repo is.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `policy-clock-test-${process.pid}.db`);
process.env.CLOCK_DB = DB_FILE;

const { db, one, q, run } = require('./db');
const P = require('./provision');
const { PRICING, schoolLimitFor, DEFAULT_PLAN } = require('./plans');
const { hashPassword, verifyPassword, csrfToken, csrfValid } = require('./auth');
const SEED = require('../data/schools.json');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !extra ? '' : `\n         ${extra}`}`);
};

console.log('\nplans');
{
  ok('there are three plans', PRICING.length === 3);
  ok('single school covers one', schoolLimitFor('school') === 1);
  ok('federation covers five', schoolLimitFor('federation') === 5);
  ok('trust is unlimited', schoolLimitFor('trust') === null);
  ok('an unknown plan gets the tightest limit, not none', schoolLimitFor('platinum') === 1);
  // The price variable name is STRIPE_PRICE_ + id.toUpperCase(). A plan id with a
  // hyphen would produce a name that can never be set, and the plan would silently
  // stop being purchasable.
  for (const p of PRICING) ok(`plan "${p.id}" makes a legal env var name`, /^[a-z][a-z0-9]*$/.test(p.id));
  ok('the default plan exists', PRICING.some(p => p.id === DEFAULT_PLAN));
}

console.log('\nslugify');
{
  const s = P.slugify;
  ok('lower-cases and hyphenates', s('Ashbourne Green Primary School') === 'ashbourne-green-primary-school', s('Ashbourne Green Primary School'));
  ok('strips punctuation', s("St. Mary's C of E (VA)!!") === 'st-mary-s-c-of-e-va', s("St. Mary's C of E (VA)!!"));
  ok('spells out an ampersand', s('Weston & Sutton') === 'weston-and-sutton', s('Weston & Sutton'));
  ok('folds an accent instead of splitting the word', s('Académie') === 'academie', s('Académie'));
  ok('never leaves a trailing hyphen', !s('Kingsmoor   ').endsWith('-'));
  ok('caps the length at 60', s('a'.repeat(200)).length === 60);
  ok('empty in, empty out', s('') === '');
  ok('null does not throw', s(null) === '');
}

console.log('\nuniqueSlug — de-duplicates rather than throwing');
{
  const free = { isTaken: () => false };
  ok('a free slug is used unchanged', P.uniqueSlug('Kingsmoor High', free) === 'kingsmoor-high');
  const taken = new Set(['st-marys']);
  const isTaken = sl => taken.has(sl);
  ok('first collision becomes -2', P.uniqueSlug('St Marys', { isTaken }) === 'st-marys-2');
  taken.add('st-marys-2');
  ok('second collision becomes -3', P.uniqueSlug('St Marys', { isTaken }) === 'st-marys-3');
  ok('an empty name still produces something usable', P.uniqueSlug('', free) === 'school');
  ok('a router-reserved slug is moved out of the way', P.uniqueSlug('New', free) === 'new-school', P.uniqueSlug('New', free));
  ok('"settings" is reserved too', P.uniqueSlug('Settings', free) === 'settings-school');
  ok('returns a string rather than throwing when everything is taken', typeof P.uniqueSlug('x', { isTaken: () => true }) === 'string');
  // The demo schools are public and linked from the marketing site. A customer named
  // "Kingsmoor Academy" must not take over /app/kingsmoor-academy.
  for (const d of SEED) ok(`a customer cannot take the demo slug "${d.slug}"`, P.uniqueSlug(d.name) !== d.slug, P.uniqueSlug(d.name));
}

console.log('\nplan selection');
{
  ok('client_reference_id is honoured', P.planFromSession({ client_reference_id: 'federation' }) === 'federation');
  ok('metadata.tier is the fallback', P.planFromSession({ metadata: { tier: 'trust' } }) === 'trust');
  ok('an expanded subscription\'s metadata is read', P.planFromSession({ subscription: { id: 'sub_1', metadata: { tier: 'federation' } } }) === 'federation');
  ok('nothing at all yields null, so the caller can go and look', P.planFromSession({}) === null);
  ok('an unknown plan yields null rather than throwing', P.planFromSession({ client_reference_id: 'platinum' }) === null);
}

console.log('\nprovisioning, and the Stripe retry that must not double it');
{
  const session = {
    id: 'cs_test_idempotency_1', client_reference_id: 'federation',
    subscription: 'sub_test_1', customer: 'cus_test_1',
    customer_details: { email: 'sbm@kingsmoor.sch.uk' },
  };
  const first = P.provisionFromCheckoutSession(session);
  ok('provisions on first delivery', first.ok === true && first.repeat === false);
  ok('plan comes from the session', first.account.plan === 'federation', first.account && first.account.plan);
  ok('email comes from the session', first.account.email === 'sbm@kingsmoor.sch.uk');
  ok('status starts trialing', first.account.status === 'trialing', first.account && first.account.status);
  ok('created_at is set', !!first.account.created_at);
  ok('all three Stripe ids are stored',
    first.account.stripe_session_id === 'cs_test_idempotency_1'
    && first.account.stripe_subscription_id === 'sub_test_1'
    && first.account.stripe_customer_id === 'cus_test_1');
  ok('a setup token is issued', typeof first.setupToken === 'string' && first.setupToken.length >= 40);
  ok('the token has an expiry', !!first.account.setup_token_expires);
  ok('there is no password yet', first.account.password_hash === null);
  ok('there are no schools yet — setup creates the first', P.schoolsForAccount(first.account.id).length === 0);

  // The one that matters. Stripe retries until it gets a 2xx, so this is normal
  // operation, not a fault, and it must not create a second account.
  const again = P.provisionFromCheckoutSession(session);
  ok('a repeat delivery is a no-op', again.ok === true && again.repeat === true);
  ok('and hands back the same account', again.account.id === first.account.id);
  ok('exactly one account exists for that session', q('SELECT id FROM accounts WHERE stripe_session_id = ?', 'cs_test_idempotency_1').length === 1);

  const resent = P.provisionFromCheckoutSession({ ...session, id: 'cs_test_idempotency_2' });
  ok('a new session on an existing subscription is also a no-op', resent.repeat === true);
  ok('still exactly one account on that subscription', q('SELECT id FROM accounts WHERE stripe_subscription_id = ?', 'sub_test_1').length === 1);

  ok('a session with no id is refused rather than guessed at', P.provisionFromCheckoutSession({}).ok === false);

  // The UNIQUE index is the guarantee, not the SELECT. Prove it.
  let threw = false;
  try { run("INSERT INTO accounts (created_at, stripe_session_id) VALUES ('x', 'cs_test_idempotency_1')"); } catch (e) { threw = true; }
  ok('the database itself refuses a second row for the session id', threw);

  // A plan passed by the caller (from the subscription's metadata) wins when the
  // session carries none; otherwise the cheapest plan, logged.
  const p2 = P.provisionFromCheckoutSession({ id: 'cs_test_plan_2', customer_details: { email: 'a@b.sch.uk' } }, { plan: 'trust' });
  ok('a caller-supplied plan is used when the session has none', p2.account.plan === 'trust');
  const p3 = P.provisionFromCheckoutSession({ id: 'cs_test_plan_3' });
  ok('no plan anywhere falls back to the cheapest (the console.error above is the test working)', p3.account.plan === DEFAULT_PLAN);
}

console.log('\nsetup tokens');
{
  const p = P.provisionFromCheckoutSession({ id: 'cs_setup_1', client_reference_id: 'school', customer_details: { email: 'sbm@tokentest.sch.uk' } });
  const account = p.account, token = p.setupToken;
  ok('a fresh token resolves', P.accountBySetupToken(token).ok === true);
  ok('and resolves to the right account', P.accountBySetupToken(token).account.id === account.id);
  ok('an unknown token is refused', P.accountBySetupToken('not-a-real-token').reason === 'unknown');
  ok('an empty token is refused', P.accountBySetupToken('').reason === 'missing');
  ok('a null token is refused', P.accountBySetupToken(null).reason === 'missing');

  const afterExpiry = new Date(Date.now() + (P.SETUP_TOKEN_DAYS + 1) * 86400000);
  ok('a token past its expiry is refused', P.accountBySetupToken(token, { now: afterExpiry }).reason === 'expired');
  const beforeExpiry = new Date(Date.now() + (P.SETUP_TOKEN_DAYS - 1) * 86400000);
  ok('one still inside the window is accepted', P.accountBySetupToken(token, { now: beforeExpiry }).ok === true);

  P.completeSetup(account.id, hashPassword('correct horse battery staple'));
  ok('completing setup burns the token', P.accountBySetupToken(token).reason === 'unknown');
  const after = one('SELECT * FROM accounts WHERE id = ?', account.id);
  ok('the password hash is stored', after.password_hash.startsWith('scrypt$'));
  ok('the token column is cleared', after.setup_token === null);
  ok('the expiry column is cleared too', after.setup_token_expires === null);
  ok('a claimed account will not re-issue a token', P.reissueSetupToken(account.id) === null);
  ok('the account can now be found by email for sign-in', P.accountsByEmail('SBM@tokentest.sch.uk').length === 1);
}

console.log('\nre-issuing a token for an account that has not claimed itself');
{
  const p = P.provisionFromCheckoutSession({ id: 'cs_setup_2', customer_details: { email: 'sbm@reissue.sch.uk' } });
  const fresh = P.reissueSetupToken(p.account.id);
  ok('an unclaimed account gets a new token', typeof fresh === 'string' && fresh !== p.setupToken);
  ok('the old token stops working', P.accountBySetupToken(p.setupToken).reason === 'unknown');
  ok('the new one works', P.accountBySetupToken(fresh).ok === true);
  ok('an unknown account id returns null', P.reissueSetupToken(999999) === null);
  ok('an unclaimed account is invisible to sign-in', P.accountsByEmail('sbm@reissue.sch.uk').length === 0);
}

console.log('\nthe school form');
{
  const good = { name: 'Kingsmoor Academy', website: 'kingsmoor.sch.uk', type: 'academy', phase: 'secondary', employees: '260', receives_pupil_premium: 'on', own_admissions_authority: 'on' };
  const r = P.schoolFromForm(good);
  ok('a good form parses', r.ok === true, r.error);
  ok('the website gets a scheme', r.school.website === 'https://kingsmoor.sch.uk/', r.school && r.school.website);
  ok('employees is a number', r.school.employees === 260);
  ok('ticked boxes are 1', r.school.receives_pupil_premium === 1 && r.school.own_admissions_authority === 1);
  ok('unticked boxes are 0, not undefined', r.school.receives_pe_premium === 0 && r.school.has_uniform === 0);
  ok('a missing name is refused', P.schoolFromForm({ ...good, name: ' ' }).ok === false);
  ok('an unknown type is refused', P.schoolFromForm({ ...good, type: 'grammar' }).ok === false);
  ok('an unknown phase is refused', P.schoolFromForm({ ...good, phase: 'sixth-form' }).ok === false);
  ok('a non-numeric employee count is refused', P.schoolFromForm({ ...good, employees: 'lots' }).ok === false);
  ok('a javascript: website is refused', P.schoolFromForm({ ...good, website: 'javascript:alert(1)' }).ok === false);
  ok('a bare word website is refused', P.schoolFromForm({ ...good, website: 'intranet' }).ok === false);
  ok('an empty website is allowed', P.schoolFromForm({ ...good, website: '' }).school.website === null);
  ok('nothing at all is refused, not thrown', P.schoolFromForm(undefined).ok === false);
}

console.log('\nschools and plan limits — the limit the code enforces is the one we sell');
{
  const mk = (id, plan) => P.provisionFromCheckoutSession({ id, client_reference_id: plan, customer_details: { email: `${id}@x.sch.uk` } }).account;
  const form = n => P.schoolFromForm({ name: `Test School ${n}`, type: 'maintained', phase: 'primary', employees: '40', receives_pupil_premium: 'on' }).school;

  const single = mk('cs_limit_school', 'school');
  ok('a single-school account can add its first', P.canAddSchool(single) === true);
  const s1 = P.createSchool(single.id, form(1));
  ok('the school gets a slug', s1.slug === 'test-school-1', s1.slug);
  ok('and belongs to the account', s1.account_id === single.id);
  ok('and then cannot add a second', P.canAddSchool(single) === false);

  const fed = mk('cs_limit_federation', 'federation');
  for (let i = 0; i < 5; i++) { ok(`federation can add school ${i + 1}`, P.canAddSchool(fed) === true); P.createSchool(fed.id, form(`fed ${i + 1}`)); }
  ok('federation cannot add a sixth', P.canAddSchool(fed) === false);
  ok('federation has five schools', P.schoolCount(fed.id) === 5);

  const trust = mk('cs_limit_trust', 'trust');
  for (let i = 0; i < 12; i++) P.createSchool(trust.id, form(`trust ${i + 1}`));
  ok('trust can keep adding past six', P.canAddSchool(trust) === true);
  ok('trust has twelve schools', P.schoolCount(trust.id) === 12);

  // Same name twice on one account is fine — it is the slug that must differ.
  const dupA = P.createSchool(trust.id, form('dup')), dupB = P.createSchool(trust.id, form('dup'));
  ok('two schools with one name get different slugs', dupA.slug !== dupB.slug, `${dupA.slug} / ${dupB.slug}`);

  const updated = P.updateSchool(s1.id, single.id, { ...form(1), name: 'Renamed', type: 'academy', employees: 300 });
  ok('updateSchool changes the profile', updated.name === 'Renamed' && updated.type === 'academy' && updated.employees === 300);
  ok('but never the slug', updated.slug === s1.slug);
  const notMine = P.updateSchool(s1.id, fed.id, { ...form(1), name: 'Hijacked' });
  ok('another account cannot update it', notMine.name === 'Renamed', notMine.name);
  ok('schoolBySlug finds it', P.schoolBySlug(s1.slug).id === s1.id);
}

console.log('\nstatus — trialing, active, cancelled; marks, never deletes');
{
  const p = P.provisionFromCheckoutSession({ id: 'cs_status_1', subscription: 'sub_status_1', customer_details: { email: 'sbm@leaving.sch.uk' } });
  const aid = p.account.id;
  const s = P.createSchool(aid, P.schoolFromForm({ name: 'Leaving Primary', type: 'maintained', phase: 'primary', employees: '30' }).school);
  run('INSERT INTO publications (school_slug, requirement_id, published_at, recorded_at) VALUES (?,?,?,?)', s.slug, 'behaviour_policy', '2026-01-10', new Date().toISOString());

  const a = P.activateBySubscription('sub_status_1');
  ok('a paid invoice makes the account active', a.ok && a.account.status === 'active', a.account && a.account.status);
  ok('a repeat activation is a no-op', P.activateBySubscription('sub_status_1').repeat === true);
  ok('an unknown subscription is reported, not thrown', P.activateBySubscription('sub_nope').reason === 'unknown-subscription');

  const r = P.cancelBySubscription('sub_status_1');
  ok('the account is marked cancelled', r.ok === true && r.account.status === 'cancelled');
  ok('the account row still exists', !!one('SELECT id FROM accounts WHERE id = ?', aid));
  ok('its school is untouched', q('SELECT id FROM schools WHERE account_id = ?', aid).length === 1);
  ok('its recorded dates are untouched', q('SELECT id FROM publications WHERE school_slug = ?', s.slug).length === 1);
  ok('a repeat cancellation is a no-op', P.cancelBySubscription('sub_status_1').repeat === true);
  ok('cancelled is sticky against a late invoice.paid', P.activateBySubscription('sub_status_1').account.status === 'cancelled');
  ok('an unknown subscription is reported, not thrown', P.cancelBySubscription('sub_does_not_exist').reason === 'unknown-subscription');
  ok('a missing subscription id is reported', P.cancelBySubscription(null).reason === 'no-subscription-id');
  ok('an expanded subscription object works as well as an id', P.cancelBySubscription({ id: 'sub_status_1' }).ok === true);
}

console.log('\npasswords and CSRF');
{
  const h = hashPassword('correct horse battery staple');
  ok('the hash is scrypt', h.startsWith('scrypt$'));
  ok('the right password verifies', verifyPassword('correct horse battery staple', h) === true);
  ok('the wrong password does not', verifyPassword('correct horse battery stapler', h) === false);
  ok('a null stored hash does not verify and does not throw', verifyPassword('anything', null) === false);
  ok('garbage stored hash does not verify', verifyPassword('anything', 'md5$abc') === false);
  ok('NFKC: composed and decomposed input hash the same', verifyPassword('café café café', hashPassword('café café café')) === true);

  const t = csrfToken('session-abc');
  ok('a token validates against its session', csrfValid(t, 'session-abc') === true);
  ok('and not against another', csrfValid(t, 'session-xyz') === false);
  ok('the empty session (setup, login, demo) works too', csrfValid(csrfToken(''), '') === true);
  ok('garbage is refused', csrfValid('nonsense', '') === false && csrfValid('', '') === false && csrfValid(null, '') === false);
}

console.log('\nmigrations are idempotent');
{
  // Requiring db.js ran the CREATEs and the ALTER loops once. Running the schema
  // block a second time against the same file must be a no-op, not an error.
  let threw = false;
  try { delete require.cache[require.resolve('./db')]; require('./db'); } catch (e) { threw = true; console.error(e); }
  ok('re-running the schema against an existing database does not throw', !threw);
  ok('and every column the code writes exists', ['stripe_session_id', 'stripe_customer_id', 'stripe_subscription_id', 'setup_token', 'setup_token_expires', 'password_hash', 'status', 'plan', 'email', 'created_at']
    .every(c => db.prepare('PRAGMA table_info(accounts)').all().some(r => r.name === c)));
  ok('the schools table has every attribute the register reads', ['type', 'phase', 'employees', 'receives_pupil_premium', 'receives_pe_premium', 'own_admissions_authority', 'has_uniform', 'website', 'slug', 'account_id']
    .every(c => db.prepare('PRAGMA table_info(schools)').all().some(r => r.name === c)));
}

db.close();
for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(`${DB_FILE}${suffix}`); } catch (e) { /* not there */ } }

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
