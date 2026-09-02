'use strict';
/**
 * Authentication, password hashing and CSRF. Zero dependencies — everything here
 * comes from node:crypto.
 *
 * Ported from parish-in-a-box/lib/auth.js on 2 September 2026, byte-for-byte where
 * it matters (the hash format, the scrypt parameters, the comparison), so a password
 * hash from either product means the same thing and the same review covers both.
 *
 * Threat model, stated plainly so future changes can be judged against it:
 *
 *   - Passwords must never be stored or logged in plain text, and a stolen database
 *     must not yield usable passwords.
 *   - Comparisons must not leak information through timing.
 *   - A malicious website must not be able to make a signed-in business manager's
 *     browser record a publication date or change a school (CSRF).
 *   - Guessing a password by brute force must be slow and rate limited (the lockout
 *     itself lives in server.js and the login_attempts table).
 *   - A session token must be unguessable and must expire.
 */
const { randomBytes, scryptSync, timingSafeEqual, createHmac } = require('crypto');

// scrypt parameters. N=16384 is the Node default and a reasonable balance for a small
// server: roughly 100ms per hash, slow enough to make offline brute force expensive,
// fast enough that nobody notices at sign-in.
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash a password for storage. Returns "scrypt$<salt hex>$<hash hex>". */
function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 1) throw new Error('A password is required.');
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Check a password against a stored hash. Always does the full work and always uses a
 * timing-safe comparison, so an attacker cannot learn whether an account exists or
 * how much of a password was correct by measuring response time.
 */
function verifyPassword(password, stored) {
  const dummy = 'scrypt$00$00';
  const parts = String(stored || dummy).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    // Still burn comparable time so a missing account is indistinguishable.
    scryptSync('x', Buffer.alloc(SALT_BYTES), SCRYPT_KEYLEN, { N: SCRYPT_N });
    return false;
  }
  let salt, expected;
  try { salt = Buffer.from(parts[1], 'hex'); expected = Buffer.from(parts[2], 'hex'); }
  catch (e) { return false; }
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) {
    scryptSync('x', Buffer.alloc(SALT_BYTES), SCRYPT_KEYLEN, { N: SCRYPT_N });
    return false;
  }
  const actual = scryptSync(String(password == null ? '' : password).normalize('NFKC'), salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return timingSafeEqual(actual, expected);
}

/** Cryptographically random session token. */
const newSessionToken = () => randomBytes(32).toString('base64url');

/**
 * Suggest a password somebody can actually read out to a colleague. Four words plus
 * digits — long, memorable, and no ambiguous characters.
 */
const WORDS = [
  'register', 'ledger', 'beacon', 'harbour', 'meadow', 'copper', 'orchard', 'lantern',
  'quarry', 'saffron', 'willow', 'granite', 'heather', 'marble', 'kestrel', 'bramble',
  'clover', 'pebble', 'thistle', 'walnut', 'anchor', 'ember', 'fathom', 'chalk',
];
function suggestPassword() {
  const pick = () => WORDS[randomBytes(1)[0] % WORDS.length];
  const digits = String(randomBytes(2).readUInt16BE(0) % 100).padStart(2, '0');
  return `${pick()}-${pick()}-${pick()}-${digits}`;
}

// ---------------------------------------------------------------- CSRF
// Signed double-submit tokens. The token is bound to the session cookie, so a token
// issued to one visitor cannot be used by another, and it is signed with a server
// secret so it cannot be forged. A visitor with no session yet (the setup page, the
// login page, the public demo) gets a token bound to the empty string — consistent,
// because the form that posts it was rendered against the same value.
//
// Cookies are SameSite=Lax, which blocks the common cross-site POST. This is the belt
// to that pair of braces: SameSite is browser-dependent and has edge cases, and a
// form this simple has no excuse not to do both.

const CSRF_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

let secret = process.env.SESSION_SECRET || '';
const SECRET_IS_EPHEMERAL = !secret;
if (!secret) {
  // Ephemeral secret. Fine locally — it just means CSRF tokens in any page already
  // open do not survive a restart, and the visitor sees "please reload and try
  // again". In production SESSION_SECRET should be set; render.yaml generates one.
  secret = randomBytes(32).toString('hex');
}

function csrfToken(sessionToken) {
  const issued = Date.now().toString(36);
  const sig = createHmac('sha256', secret).update(`${sessionToken}.${issued}`).digest('base64url').slice(0, 32);
  return `${issued}.${sig}`;
}

function csrfValid(token, sessionToken) {
  const [issued, sig] = String(token || '').split('.');
  if (!issued || !sig) return false;
  const age = Date.now() - parseInt(issued, 36);
  if (!Number.isFinite(age) || age < 0 || age > CSRF_TTL_MS) return false;
  const expected = createHmac('sha256', secret).update(`${sessionToken}.${issued}`).digest('base64url').slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hidden input to drop into every form. */
const csrfField = sessionToken => `<input type="hidden" name="_csrf" value="${csrfToken(sessionToken || '')}">`;

/**
 * Reject cross-origin form posts as a second layer, using the Origin header. Returns
 * true if the request looks same-origin or carries no Origin at all (some legitimate
 * clients omit it).
 */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

module.exports = {
  hashPassword, verifyPassword, newSessionToken, suggestPassword,
  csrfToken, csrfValid, csrfField, originOk, SECRET_IS_EPHEMERAL,
};
