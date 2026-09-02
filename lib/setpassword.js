'use strict';
/**
 * Reset a customer's password from the command line.
 *
 *   node lib/setpassword.js sbm@example.sch.uk 'three or four unrelated words'
 *
 * There is no self-service password reset, because there is no email in this product
 * and a reset link with nowhere to send it is not a reset. So when a customer emails
 * to say they have forgotten theirs, this is the manual step: run it in Render's
 * shell against the live database (CLOCK_DB is already set there), then tell them the
 * new password by a channel you trust and ask them to change nothing else.
 *
 * Applies to every claimed account with that email — there is usually exactly one.
 * Unclaimed accounts (no password yet) are left alone; those still have their setup
 * link on /welcome.
 */
const { hashPassword } = require('./auth');
const { q, run } = require('./db');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node lib/setpassword.js <email> <new password>');
  process.exit(2);
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters, the same rule the setup page applies.');
  process.exit(2);
}
const accounts = q('SELECT id, email, plan, status FROM accounts WHERE lower(email) = lower(?) AND password_hash IS NOT NULL', email);
if (!accounts.length) {
  console.error(`No claimed account for ${email}. If they have paid but never set up, send them back to their /welcome page.`);
  process.exit(1);
}
const hash = hashPassword(password);
for (const a of accounts) {
  run('UPDATE accounts SET password_hash = ? WHERE id = ?', hash, a.id);
  run('DELETE FROM sessions WHERE account_id = ?', a.id);   // sign out everywhere, as a reset should
  console.log(`Password set for account ${a.id} (${a.email}, ${a.plan}, ${a.status}). Existing sessions ended.`);
}
