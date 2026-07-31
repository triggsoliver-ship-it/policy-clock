'use strict';
/**
 * Policy Clock — the statutory register for English state-funded schools.
 *
 * Every entry cites a primary source. If a requirement cannot be traced to legislation
 * or to current DfE guidance, it does not go in here, and nothing in this file is
 * described as a legal requirement unless the source says "must".
 *
 * ── A finding that shapes this whole product ──────────────────────────────────
 * DfE's consolidated list, "Statutory policies for schools and academy trusts", was
 * WITHDRAWN on 7 March 2024. It is the document most schools and most competitors still
 * work from. There is no replacement single list — DfE now points to the maintained
 * school governance guide and the academy trust governance guide, and the actual duties
 * are spread across the School Information (England) Regulations 2008, the Equality Act
 * 2010, the Children and Families Act 2014 and a dozen separate guidance pages.
 *
 * That fragmentation is the product. We re-derive the register from live sources and
 * mark each item's provenance so a school can see exactly what it is relying on.
 * ──────────────────────────────────────────────────────────────────────
 *
 * Sources, all verified 2026-07-31:
 *  [PUB-M]   What maintained schools must or should publish online — DfE, last updated
 *            24 Oct 2024. https://www.gov.uk/guidance/what-maintained-schools-must-publish-online
 *  [PUB-A]   What academies and further education colleges must or should publish online
 *            https://www.gov.uk/guidance/what-academies-free-schools-and-colleges-should-publish-online
 *  [SIR2008] School Information (England) Regulations 2008, as amended 2012 and 2016.
 *            https://www.legislation.gov.uk/uksi/2008/3093/contents/made
 *  [EA2010]  Equality Act 2010 s149 (public sector equality duty) and Sch 10 para 3
 *            (accessibility plans). Specific Duties Regs 2017.
 *  [CFA2014] Children and Families Act 2014 s69; SEND Regulations 2014 Sch 1.
 *  [EA2002]  Education Act 2002 s29 (complaints procedure).
 *  [EIA2006] Education and Inspections Act 2006 s89 (behaviour policy).
 *  [EA1997]  Education Act 1997 s42B (provider access statement).
 *  [GPG2017] Equality Act 2010 (Gender Pay Gap Information) Regulations 2017.
 *  [WITHDRAWN] Statutory policies for schools and academy trusts — DfE, withdrawn
 *            7 March 2024. Used ONLY for review-cycle and approval-level hints, always
 *            labelled as withdrawn guidance, never as a current legal requirement.
 */

const MAINTAINED = 'maintained', ACADEMY = 'academy';
const MUST = 'must', SHOULD = 'should';

/** Deadline helpers. Academic year runs Sept–Aug. */
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

/** Next occurrence of a fixed calendar date, on or after `from`. */
function nextFixed(month, day, from) {
  const y = from.getUTCFullYear();
  const candidate = D(y, month, day);
  return candidate >= from ? candidate : D(y + 1, month, day);
}
/** The most recent occurrence of a fixed date, on or before `from`. */
function lastFixed(month, day, from) {
  const y = from.getUTCFullYear();
  const candidate = D(y, month, day);
  return candidate <= from ? candidate : D(y - 1, month, day);
}

/**
 * The register.
 *
 * force:      'must' | 'should'   — taken verbatim from the source wording.
 * appliesTo:  which school types, and an optional predicate on school attributes.
 * cadence:    'fixed-date' | 'annual' | 'multi-year' | 'live' | 'on-change'
 * deadline:   for fixed-date items, (now) => Date
 * periodMonths: for annual/multi-year items, how stale is too stale.
 */
const REQUIREMENTS = [
  // ── Fixed calendar deadlines. These are the ones schools actually miss. ──────────
  {
    id: 'pupil_premium_statement',
    title: 'Pupil premium strategy statement',
    group: 'Funding',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.receives_pupil_premium },
    cadence: 'fixed-date',
    deadline: now => nextFixed(12, 31, now),
    lastDue: now => lastFixed(12, 31, now),
    source: '[PUB-M] Pupil premium — "must publish a strategy statement on their school website by 31 December each year", in the DfE template',
    detail: 'Must explain how the funding is being spent and the outcomes achieved for disadvantaged pupils. Must use the DfE template. If planning over 3 years, the statement must still be updated annually.',
  },
  {
    id: 'pe_sport_premium',
    title: 'PE and sport premium report',
    group: 'Funding',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.receives_pe_premium },
    cadence: 'fixed-date',
    deadline: now => nextFixed(7, 31, now),
    lastDue: now => lastFixed(7, 31, now),
    source: '[PUB-M] PE and sport premium — "must publish, by 31 July each year"',
    detail: 'Amount received, full breakdown of spend, impact on participation and attainment, and how the improvement will be sustained. Also by 31 July: the percentage of the year 6 cohort meeting the national curriculum swimming requirements. If publishing the digital form return, it must be converted to HTML for accessibility.',
  },
  {
    id: 'admission_arrangements',
    title: 'Admission arrangements for next September',
    group: 'Admissions',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.own_admissions_authority },
    cadence: 'fixed-date',
    deadline: now => nextFixed(3, 15, now),
    lastDue: now => lastFixed(3, 15, now),
    source: '[PUB-M] Admission arrangements — "By 15 March each year, the school must publish on its website the admission arrangements"',
    detail: 'Must be retained on the website for the whole academic year in which offers are made. Must cover how applications are considered, the published admission number, how to apply, and how places are allocated when oversubscribed. Applies to foundation and voluntary-aided schools, and to academies as their own admissions authority.',
  },
  {
    id: 'admission_appeals_timetable',
    title: 'Admission appeals timetable',
    group: 'Admissions',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.own_admissions_authority },
    cadence: 'fixed-date',
    deadline: now => nextFixed(2, 28, now),
    lastDue: now => lastFixed(2, 28, now),
    source: '[PUB-M] Admission appeals — "By 28 February each year, the school must publish a timetable"',
    detail: 'Must allow parents at least 20 school days from notification to lodge an appeal, give at least 10 school days\' notice of the hearing, and send decision letters within 5 school days of the hearing wherever possible.',
  },
  {
    id: 'in_year_admissions',
    title: 'In-year admissions process',
    group: 'Admissions',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.own_admissions_authority },
    cadence: 'fixed-date',
    deadline: now => nextFixed(8, 31, now),
    lastDue: now => lastFixed(8, 31, now),
    source: '[PUB-M] In-year admissions — "By 31 August each year, the school must publish how it will manage in-year applications"',
    detail: 'If the governing body manages in-year applications it must provide an application form and any supplementary information. If the local authority manages them, publish a link to the in-year co-ordination scheme.',
  },
  {
    id: 'gender_pay_gap',
    title: 'Gender pay gap report',
    group: 'Staffing',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => (s.employees || 0) >= 250 },
    cadence: 'fixed-date',
    deadline: now => nextFixed(3, 30, now), // one year after the 31 March snapshot
    lastDue: now => lastFixed(3, 30, now),
    source: '[GPG2017] and [PUB-M] Pay gap reporting — report to the gender pay gap service and publish on the website within one year of the snapshot date, which for most public authority employers is 31 March',
    detail: 'Only schools with 250 or more employees. Schools below that threshold are not required to comply. Note the snapshot date is 31 March and publication is due within one year of it.',
  },

  // ── Annual and multi-year items ──────────────────────────────────────────
  {
    id: 'sen_information_report',
    title: 'SEN information report',
    group: 'SEND',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[CFA2014] s69 and SEND Regulations 2014 Sch 1; [PUB-M] — "should be updated annually and any changes... updated as soon as possible"',
    detail: 'Must contain the information specified in Schedule 1 to the SEND Regulations 2014, plus arrangements for admission of disabled pupils, steps to prevent less favourable treatment, facilities provided, and the accessibility plan.',
  },
  {
    id: 'psed_compliance',
    title: 'Public sector equality duty — compliance information',
    group: 'Equality',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[EA2010] s149 and Specific Duties Regs 2017; [PUB-M] — "details of how they comply with the public sector equality duty, updating this every year"',
    detail: 'Annual publication of information demonstrating compliance with the general duty.',
  },
  {
    id: 'equality_objectives',
    title: 'Equality objectives',
    group: 'Equality',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'multi-year', periodMonths: 48,
    source: '[EA2010] Specific Duties Regs 2017; [PUB-M] — "their equality objectives, updating these at least every 4 years"',
    detail: 'At least every four years. Separate from, and longer-cycle than, the annual compliance information above — the two are commonly confused and published together on the wrong cycle.',
  },
  {
    id: 'accessibility_plan',
    title: 'Accessibility plan',
    group: 'Equality',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'multi-year', periodMonths: 36,
    source: '[EA2010] Sch 10 para 3; [PUB-M] Curriculum and SEND sections. Three-year cycle per [WITHDRAWN] DfE statutory policies list (withdrawn 7 Mar 2024) — the Act itself sets no fixed interval',
    detail: 'Must set out how, over time, the school will increase disabled pupils\' participation in the curriculum, improve the physical environment, and improve access to information. Three years is the conventional cycle, taken from now-withdrawn DfE guidance rather than from the Act.',
    provenanceWarning: true,
  },
  {
    id: 'careers_programme',
    title: 'Careers programme information and provider access statement',
    group: 'Curriculum',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.phase === 'secondary' || s.phase === 'all-through' },
    cadence: 'annual', periodMonths: 12,
    source: '[EA1997] s42B; [PUB-M] Careers programme information',
    detail: 'For the current academic year: the careers lead\'s name and contact details, a summary of the programme, how impact is measured, and the date by which the information will be reviewed. Plus a provider access statement under section 42B.',
  },
  {
    id: 'child_protection',
    title: 'Child protection policy',
    group: 'Safeguarding',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: 'Keeping children safe in education (statutory guidance); [WITHDRAWN] list gave "annually, governing body or proprietor"',
    detail: 'Reviewed and updated annually as a minimum, approved by the governing body or proprietor, and available publicly on the school website. KCSIE is reissued most years — a reissue is a trigger to review.',
  },

  // ── Always-on published information ────────────────────────────────────────
  {
    id: 'behaviour_policy',
    title: 'Behaviour policy',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[EIA2006] s89; [PUB-M] Behaviour policy',
    detail: 'Must be published and must comply with section 89 of the Education and Inspections Act 2006.',
  },
  {
    id: 'complaints_policy',
    title: 'Complaints procedure',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED] },
    cadence: 'annual', periodMonths: 12,
    source: '[EA2002] s29; [PUB-M] Complaints policy',
    detail: 'Maintained schools must publish it. Academies must have a written complaints procedure available on request; DfE recommends publishing online. Must also cover complaints about SEN support, as part of the SEN information report.',
  },
  {
    id: 'charging_remissions',
    title: 'Charging and remissions policy',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: 'Education Act 1996 ss449–462; [PUB-M] Charging and remissions policies',
    detail: 'Both the charging policy and the remissions policy must be published.',
  },
  {
    id: 'curriculum_content',
    title: 'Curriculum content by year and subject',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[SIR2008]; [PUB-M] Curriculum',
    detail: 'Content for each academic year for every subject including RE, the right to withdraw from RE, and how to find out more. Key stage 1 providers must also publish their phonics or reading scheme; key stage 4 providers the list of courses offered.',
  },
  {
    id: 'financial_information',
    title: 'Financial information — £100k+ salaries and benchmarking link',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] Financial information',
    detail: 'The number of employees with gross annual salary over £100,000, in £10,000 bandings, plus a link to the school\'s page on the schools financial benchmarking service.',
  },
  {
    id: 'governance_information',
    title: 'Governance information',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] Governance information; Constitution of governing bodies of maintained schools',
    detail: 'Must publish information about the governing body and its committees. DfE also says schools should publish, for each governor serving in the past 12 months: full name, date appointed, term of office, who appointed them, attendance record, and relevant business and pecuniary interests.',
  },
  {
    id: 'ofsted_report',
    title: 'Most recent Ofsted report or link',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'on-change',
    source: '[PUB-M] Ofsted reports',
    detail: 'Either a copy of the most recent report or a link to it on the Ofsted website.',
  },
  {
    id: 'performance_measures',
    title: 'Test, exam and assessment results',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] Test, exam and assessment results',
    detail: 'A link to the compare school and college performance service and the school\'s page on it, plus the relevant key stage headline measures. Note DfE has suspended several progress measures for specific years — check the current guidance rather than assuming.',
  },
  {
    id: 'contact_details',
    title: 'Contact details and SENCO',
    group: 'Published information',
    force: MUST,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'on-change',
    source: '[SIR2008]; [PUB-M] Contact details',
    detail: 'Postal address, telephone number, and the name of the member of staff who deals with queries. Mainstream schools must also publish the name and contact details of the SENCO.',
  },

  // ── "Should" items. Shown separately and never described as legal requirements. ───
  {
    id: 'school_uniform',
    title: 'School uniform policy',
    group: 'Recommended',
    force: SHOULD,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.has_uniform },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] School uniform — "should publish an easily understandable policy", in line with statutory guidance on the cost of school uniforms',
    detail: 'Optional versus required items, seasonal items, branded versus generic, whether items are single-supplier, and where second-hand uniform can be bought.',
  },
  {
    id: 'opening_hours',
    title: 'School opening hours',
    group: 'Recommended',
    force: SHOULD,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] School opening hours',
    detail: 'Official start and end time of the compulsory school day and the weekly total including breaks.',
  },
  {
    id: 'remote_education',
    title: 'Remote education provision',
    group: 'Recommended',
    force: SHOULD,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] Remote education',
    detail: 'DfE says schools should publish information about their remote education provision.',
  },
  {
    id: 'music_development_plan',
    title: 'Music development plan summary',
    group: 'Recommended',
    force: SHOULD,
    appliesTo: { types: [MAINTAINED, ACADEMY], when: s => s.phase !== 'special' },
    cadence: 'annual', periodMonths: 12,
    source: '[PUB-M] Curriculum — "all schools are expected to publish information about their music development plan"; DfE template available',
    detail: 'Published alongside the music curriculum content.',
  },
  {
    id: 'ethos_values',
    title: 'Ethos and values statement',
    group: 'Recommended',
    force: SHOULD,
    appliesTo: { types: [MAINTAINED, ACADEMY] },
    cadence: 'on-change',
    source: '[PUB-M] Ethos and values',
    detail: 'DfE says schools should publish a statement setting out their ethos and values.',
  },
];

function applicable(req, school) {
  if (!req.appliesTo.types.includes(school.type)) return false;
  if (req.appliesTo.when && !req.appliesTo.when(school)) return false;
  return true;
}

module.exports = { REQUIREMENTS, applicable, MAINTAINED, ACADEMY, MUST, SHOULD, nextFixed, lastFixed };
