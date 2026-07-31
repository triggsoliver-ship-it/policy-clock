'use strict';
/**
 * Policy Clock — compliance engine.
 *
 * Takes a school's profile and the dates it last published each item, and returns a
 * status per requirement plus a prioritised action list and a governors' report.
 *
 * Design rule: the engine never invents a legal obligation. A requirement whose source
 * says "should" is scored separately from one whose source says "must", and the two are
 * never combined into a single headline number.
 */
const { REQUIREMENTS, applicable, MUST } = require('./requirements');

const DAY = 86400000;
const OVERDUE = 'overdue', DUE_SOON = 'due_soon', OK = 'ok', MISSING = 'missing', STALE = 'stale';

const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const iso = d => new Date(d).toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

/**
 * @param {object} school   { name, type, phase, employees, receives_pupil_premium, ... }
 * @param {object} state    { [requirementId]: { published_at, url } }
 * @param {Date}   now
 * @param {number} warnDays how far ahead to flag something as due soon
 */
function evaluate(school, state = {}, now = new Date(), warnDays = 45) {
  const results = [];

  for (const req of REQUIREMENTS) {
    if (!applicable(req, school)) continue;

    const rec = state[req.id] || {};
    const published = rec.published_at ? new Date(rec.published_at) : null;
    let status, message, due = null, action = null;

    if (req.cadence === 'fixed-date') {
      const lastDue = req.lastDue(now);   // most recent deadline that has passed
      const nextDue = req.deadline(now);  // the next one coming
      // The cycle that ended at lastDue opened the day after the deadline before it.
      // Publishing at any point inside that window satisfies the duty — publishing
      // early is compliant, which an earlier version of this got backwards.
      const prevDue = new Date(Date.UTC(lastDue.getUTCFullYear() - 1, lastDue.getUTCMonth(), lastDue.getUTCDate()));
      due = nextDue;
      if (!published) {
        status = MISSING;
        message = `Nothing published. The ${fmt(lastDue)} deadline passed ${days(lastDue, now)} days ago.`;
        action = `Publish now — this is already late. The next deadline after that is ${fmt(nextDue)}.`;
      } else if (published > prevDue) {
        const left = days(now, nextDue);
        status = left <= warnDays ? DUE_SOON : OK;
        message = published > lastDue
          ? `Published ${fmt(published)}, ahead of the ${fmt(nextDue)} deadline.`
          : `Published ${fmt(published)}, meeting the ${fmt(lastDue)} deadline.`;
        action = left <= warnDays ? `Next version due ${fmt(nextDue)} — ${left} days away.` : `Next due ${fmt(nextDue)}.`;
      } else {
        status = OVERDUE;
        message = `Last published ${fmt(published)}, which belongs to an earlier cycle. The ${fmt(lastDue)} deadline was missed ${days(lastDue, now)} days ago.`;
        action = 'Republish for the current cycle as a priority.';
      }
    } else if (req.cadence === 'annual' || req.cadence === 'multi-year') {
      const periodDays = Math.round(req.periodMonths * 30.44);
      if (!published) {
        status = MISSING;
        message = 'Nothing recorded as published.';
        action = `Publish and record the date. Review cycle is every ${req.periodMonths} months.`;
      } else {
        const age = days(published, now);
        due = new Date(published.getTime() + periodDays * DAY);
        if (age > periodDays) {
          status = STALE;
          message = `Last reviewed ${fmt(published)} — ${Math.floor(age / 30.44)} months ago, against a ${req.periodMonths} month cycle.`;
          action = `Overdue for review by ${Math.floor((age - periodDays) / 30.44)} months.`;
        } else if (days(now, due) <= warnDays) {
          status = DUE_SOON;
          message = `Last reviewed ${fmt(published)}. Review due ${fmt(due)}.`;
          action = `Schedule for the next governors' meeting — due in ${days(now, due)} days.`;
        } else {
          status = OK;
          message = `Reviewed ${fmt(published)}. Next review due ${fmt(due)}.`;
        }
      }
    } else { // 'live' / 'on-change'
      if (!published) {
        status = MISSING;
        message = 'Nothing recorded as published.';
        action = 'Publish and record the date.';
      } else {
        status = OK;
        message = `Published ${fmt(published)}. Update whenever the underlying facts change.`;
      }
    }

    results.push({
      id: req.id, title: req.title, group: req.group, force: req.force,
      status, message, action,
      due: due ? iso(due) : null,
      published_at: published ? iso(published) : null,
      url: rec.url || null,
      source: req.source, detail: req.detail,
      provenanceWarning: !!req.provenanceWarning,
    });
  }

  // Score "must" items only. Mixing in "should" items would overstate legal exposure.
  const musts = results.filter(r => r.force === MUST);
  const bad = new Set([OVERDUE, MISSING, STALE]);
  const failing = musts.filter(r => bad.has(r.status));
  const score = musts.length ? Math.round(((musts.length - failing.length) / musts.length) * 100) : 100;

  // Priority: statutory duties before DfE recommendations, then by how badly missed.
  // Getting this the other way round buried an overdue legal deadline beneath a
  // "should" item nobody has to do.
  const weight = { [MISSING]: 0, [OVERDUE]: 1, [STALE]: 2, [DUE_SOON]: 3, [OK]: 4 };
  const forceRank = r => (r.force === MUST ? 0 : 1);
  const actions = results
    .filter(r => r.status !== OK)
    .sort((a, b) => (forceRank(a) - forceRank(b))
      || (weight[a.status] - weight[b.status])
      || String(a.due).localeCompare(String(b.due)));

  return {
    school, generated_at: now.toISOString(),
    score,
    counts: {
      must: musts.length,
      failingMust: failing.length,
      dueSoon: results.filter(r => r.status === DUE_SOON).length,
      recommended: results.filter(r => r.force !== MUST).length,
    },
    headline: failing.length
      ? `${failing.length} statutory item${failing.length > 1 ? 's' : ''} not currently compliant`
      : 'All statutory publishing items up to date',
    results, actions,
  };
}

/** Plain-text summary a clerk or business manager can paste into a governors' pack. */
function governorsSummary(report) {
  const L = [];
  L.push(`STATUTORY PUBLISHING POSITION — ${report.school.name}`);
  L.push(`Generated ${fmt(report.generated_at)}`);
  L.push('');
  L.push(`Statutory items in scope: ${report.counts.must}`);
  L.push(`Not currently compliant:  ${report.counts.failingMust}`);
  L.push(`Due within 45 days:       ${report.counts.dueSoon}`);
  L.push(`Compliance score:         ${report.score}%`);
  L.push('');
  if (!report.actions.length) {
    L.push('No action required.');
  } else {
    L.push('ACTIONS, most urgent first');
    L.push('');
    report.actions.forEach((a, i) => {
      L.push(`${i + 1}. [${a.force.toUpperCase()}] ${a.title}`);
      L.push(`   ${a.message}`);
      if (a.action) L.push(`   → ${a.action}`);
      L.push(`   Source: ${a.source}`);
      L.push('');
    });
  }
  L.push('---');
  L.push('Prepared by Policy Clock. Every item cites its primary source. This is a');
  L.push('compliance tracking tool, not legal advice.');
  return L.join('\n');
}

module.exports = { evaluate, governorsSummary, OVERDUE, DUE_SOON, OK, MISSING, STALE };
