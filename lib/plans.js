'use strict';
/**
 * The three plans, in one place.
 *
 * This used to live inside server.js. It moved out on 2 September 2026 because
 * provisioning (lib/provision.js) needs to know which plan ids exist and how many
 * schools each one covers, and requiring server.js from a library would start the
 * server. Nothing about the plans themselves changed.
 *
 *   schools   How many schools the plan covers. null means no limit. This is the
 *             number the code actually enforces (see canAddSchool in lib/provision.js),
 *             so it must agree with the blurb — a limit we advertise and do not
 *             enforce is a discount nobody asked for, and one we enforce and do not
 *             advertise is a support email.
 *
 * Prices are the total payable. Keelson Holdings Ltd is not VAT registered, so no
 * VAT is added anywhere and nothing here should ever imply it.
 */
const PRICING = [
  { id: 'school', name: 'Single school', price: 39, schools: 1, blurb: 'One school, one clock.',
    features: ['Every statutory publishing deadline tracked', 'Governors\' evidence pack', 'Source citation on every item', 'Email reminders 45 days out (coming soon)'] },
  { id: 'federation', name: 'Federation', price: 149, schools: 5, featured: true, blurb: 'Up to five schools.',
    features: ['Everything in Single school', 'Up to 5 schools', 'Cross-school dashboard (coming soon)', 'Consolidated board report (coming soon)'] },
  { id: 'trust', name: 'Trust', price: 399, schools: null, blurb: 'Six schools or more.',
    features: ['Everything in Federation', 'Unlimited schools', 'JSON API today; CSV export coming soon', 'Trust-level exception report (coming soon)', 'Priority support'] },
];

const PLAN_IDS = new Set(PRICING.map(p => p.id));

/**
 * Where an account lands if its Checkout Session carries no recognisable plan.
 * The cheapest, deliberately: provisioning a paying customer on too small a plan is
 * a support email; provisioning them on too big a plan is a gift; refusing to
 * provision them at all is a broken promise. Always logged loudly when it happens.
 */
const DEFAULT_PLAN = 'school';

const planById = id => PRICING.find(p => p.id === id) || null;

/** The school limit for a plan id. Unknown plan ids get the tightest limit. */
function schoolLimitFor(planId) {
  const p = planById(planId);
  return p ? p.schools : 1;
}

module.exports = { PRICING, PLAN_IDS, DEFAULT_PLAN, planById, schoolLimitFor };
