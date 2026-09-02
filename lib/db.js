'use strict';
/**
 * Storage. Node's built-in SQLite (node:sqlite, Node >= 22.5) — still no dependencies.
 *
 * This used to be a block at the top of server.js. It moved into its own module on
 * 2 September 2026 for two reasons:
 *
 *   1. Provisioning (lib/provision.js) has to read and write the database, and it
 *      cannot require server.js without starting the server.
 *   2. The tests (lib/provisiontest.js) need a throwaway database. CLOCK_DB is read
 *      the moment this file is required, so a test sets the variable first and then
 *      requires this — and never touches data/clock.db.
 *
 * The two demo schools are NOT in here. They live in data/schools.json, exactly as
 * before, because they are the live demo the marketing site links to and they must
 * keep working whatever happens to the database. Customer schools live in the
 * `schools` table below, because a webhook and a setup form writing to one JSON file
 * at the same moment is how you lose a paying customer's record.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA, { recursive: true });

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
const opened = openDb();
const db = opened.db;

// WAL lets the webhook write while a dashboard reads, without either waiting on the
// other. It needs a filesystem with shared memory, which some mounts lack, so fall
// back rather than refuse to start. busy_timeout means a genuinely concurrent write
// waits its turn instead of throwing SQLITE_BUSY at a customer mid-setup.
try { db.exec('PRAGMA journal_mode = WAL'); } catch (e) { db.exec('PRAGMA journal_mode = DELETE'); }
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
    school TEXT, role TEXT, created_at TEXT NOT NULL);

  -- Publication dates, keyed on the school's slug. Demo and customer schools share
  -- this table: a demo slug's rows overlay data/schools.json, a customer slug's rows
  -- are the whole record.
  CREATE TABLE IF NOT EXISTS publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, school_slug TEXT NOT NULL,
    requirement_id TEXT NOT NULL, published_at TEXT NOT NULL, url TEXT,
    recorded_at TEXT NOT NULL, UNIQUE(school_slug, requirement_id));

  -- One row per paying customer. The thing a Stripe subscription belongs to and the
  -- thing a password belongs to. Schools hang off it, because the Federation and
  -- Trust plans cover more than one.
  --
  --   stripe_session_id      The Checkout Session that paid, and the idempotency key
  --                          for provisioning. Stripe retries a webhook until it gets
  --                          a 2xx, so the same checkout.session.completed arrives
  --                          more than once as normal operation. See the UNIQUE index.
  --   stripe_customer_id     Lets a Stripe dashboard row be traced to an account.
  --   stripe_subscription_id What invoice.paid and customer.subscription.deleted
  --                          arrive with, so it is the only way to know whose it is.
  --   status                 'trialing' from checkout, 'active' once a real invoice
  --                          is paid, 'cancelled' when the subscription ends. A
  --                          cancelled account keeps every row it ever had.
  --   setup_token            The one-time secret in the /setup/<token> URL. This
  --                          product sends no email, so this link is the whole
  --                          handover. Cleared the moment a password is set.
  --   setup_token_expires    ISO timestamp. A token past this is refused.
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    plan TEXT NOT NULL DEFAULT 'school',
    status TEXT NOT NULL DEFAULT 'trialing',
    password_hash TEXT,
    stripe_session_id TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    setup_token TEXT,
    setup_token_expires TEXT,
    created_at TEXT NOT NULL);

  -- A customer's school. The columns after website are exactly the attributes
  -- lib/requirements.js reads to decide which duties apply: type and phase pick
  -- the register, employees >= 250 switches on gender pay gap reporting, and the
  -- three flags switch on pupil premium, PE premium, and the admissions items.
  -- Booleans are 0/1 because SQLite has no boolean and node:sqlite will not bind one.
  CREATE TABLE IF NOT EXISTS schools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    website TEXT,
    type TEXT NOT NULL DEFAULT 'maintained',
    phase TEXT NOT NULL DEFAULT 'primary',
    employees INTEGER NOT NULL DEFAULT 0,
    receives_pupil_premium INTEGER NOT NULL DEFAULT 1,
    receives_pe_premium INTEGER NOT NULL DEFAULT 1,
    own_admissions_authority INTEGER NOT NULL DEFAULT 0,
    has_uniform INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL,
    expires_at TEXT);

  -- Failed sign-in attempts, for lockout. Kept in the database rather than in
  -- memory so a restart cannot be used to clear an attacker's counter.
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    at TEXT NOT NULL);
`);

// ---------------------------------------------------------------- migrations
// Applied idempotently, so a database created by an earlier version of this file
// picks up new columns on the next boot without losing a row. Today every column
// above is in the CREATE, so these loops do nothing on a fresh database; they exist
// so that the next column added goes in here and not in a hand-run ALTER on Render.
const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
for (const [col, ddl] of [
  ['password_hash', 'TEXT'], ['stripe_session_id', 'TEXT'], ['stripe_customer_id', 'TEXT'],
  ['stripe_subscription_id', 'TEXT'], ['setup_token', 'TEXT'], ['setup_token_expires', 'TEXT'],
  ['status', "TEXT NOT NULL DEFAULT 'trialing'"], ['plan', "TEXT NOT NULL DEFAULT 'school'"],
]) {
  if (!columns('accounts').includes(col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${ddl}`);
}
for (const [col, ddl] of [
  ['website', 'TEXT'], ['type', "TEXT NOT NULL DEFAULT 'maintained'"], ['phase', "TEXT NOT NULL DEFAULT 'primary'"],
  ['employees', 'INTEGER NOT NULL DEFAULT 0'], ['receives_pupil_premium', 'INTEGER NOT NULL DEFAULT 1'],
  ['receives_pe_premium', 'INTEGER NOT NULL DEFAULT 1'], ['own_admissions_authority', 'INTEGER NOT NULL DEFAULT 0'],
  ['has_uniform', 'INTEGER NOT NULL DEFAULT 1'],
]) {
  if (!columns('schools').includes(col)) db.exec(`ALTER TABLE schools ADD COLUMN ${col} ${ddl}`);
}
if (!columns('sessions').includes('expires_at')) db.exec('ALTER TABLE sessions ADD COLUMN expires_at TEXT');

// The UNIQUE indexes are the real idempotency guarantee. Checking for an existing row
// and then inserting is not atomic — two deliveries of the same event can both pass
// the check before either writes — so the database has to be the one that says no.
// SQLite treats NULLs as distinct in a unique index, so accounts created by hand
// (NULL here) never collide; only two rows claiming the same real Stripe id can.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_stripe_session ON accounts(stripe_session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_stripe_subscription ON accounts(stripe_subscription_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_setup_token ON accounts(setup_token);
  CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
  CREATE INDEX IF NOT EXISTS idx_schools_account ON schools(account_id);
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(identifier, at);
`);

const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null;
const run = (sql, ...args) => db.prepare(sql).run(...args);

/** Delete expired sessions, stale lockout records and dead setup tokens. */
function purgeExpired() {
  const now = new Date().toISOString();
  run('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?', now);
  run('DELETE FROM login_attempts WHERE at < ?', new Date(Date.now() - 60 * 60 * 1000).toISOString());
  // An expired setup token is a dead secret, and a dead secret in a backup is still
  // a secret that can leak. Nothing depends on it surviving: provision.js refuses an
  // expired token anyway, and /welcome mints a fresh one for any account that still
  // has no password.
  run(`UPDATE accounts SET setup_token = NULL, setup_token_expires = NULL
       WHERE setup_token IS NOT NULL AND setup_token_expires IS NOT NULL AND setup_token_expires < ?`, now);
}

module.exports = {
  db, q, one, run, purgeExpired, DATA,
  DB_PERSISTENT: opened.persistent, DB_LOCATION: opened.location,
};
