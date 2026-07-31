'use strict';
/**
 * Terms of service and privacy notice, served at /terms and /privacy.
 *
 * Plain English, short, and honest. These were drafted by an AI assistant and have
 * NOT been reviewed by a solicitor — Oli should have both looked over before serious
 * volume. They are deliberately conservative: no promises the product does not keep.
 */

const TERMS = `
<section style="padding:52px 0"><div class="wrap" style="max-width:760px">
<h2>Terms of service</h2>
<p class="note">Last updated 31 July 2026</p>

<p><strong>Who we are.</strong> Policy Clock is operated by Oliver Triggs, trading from the
United Kingdom ("we", "us"). Contact: oli@parishinabox.co.uk.</p>

<p><strong>What Policy Clock is.</strong> Policy Clock is a compliance tracking tool. It
maintains a register of statutory publishing requirements for English state-funded
schools, tracks deadlines against dates you record, and produces summary reports. It is
an administrative aid.</p>

<p><strong>What Policy Clock is not.</strong> It is not legal advice, and it is not a
guarantee of compliance. Requirements are derived from legislation and Department for
Education guidance, which change; we work to keep the register current and cite our
sources, but responsibility for a school's statutory compliance rests with the school,
its governing body or trust. Where a requirement is uncertain or comes from withdrawn
guidance, we say so rather than presenting it as law.</p>

<p><strong>Subscriptions and billing.</strong> Paid plans are billed monthly in advance
by card through Stripe. Where offered, trials are free for the stated period and you can
cancel at any time before the trial ends without charge. You can cancel your subscription
at any time, taking effect at the end of the current billing period. Prices exclude VAT
where applicable.</p>

<p><strong>Refunds.</strong> If something is broken or the service has not done what this
page says it does, email us and we will put it right or refund the affected period. Your
statutory rights are unaffected.</p>

<p><strong>Fair use.</strong> Don't attempt to disrupt the service, resell it without
agreement, or use it to misrepresent a school's compliance position to a third party.</p>

<p><strong>Liability.</strong> To the extent permitted by law, our total liability in any
twelve month period is limited to the fees you paid in that period. Nothing here limits
liability that cannot lawfully be limited.</p>

<p><strong>Changes.</strong> We may update these terms; material changes will be notified
to subscribers by email at least 14 days before they take effect.</p>

<p><strong>Governing law.</strong> These terms are governed by the law of England and
Wales, and the courts of England and Wales have jurisdiction.</p>
</div></section>`;

const PRIVACY = `
<section style="padding:52px 0"><div class="wrap" style="max-width:760px">
<h2>Privacy notice</h2>
<p class="note">Last updated 31 July 2026</p>

<p><strong>Who we are.</strong> Policy Clock is operated by Oliver Triggs (contact:
oli@parishinabox.co.uk), who is the data controller for personal data collected through
this site.</p>

<p><strong>What we collect and why.</strong></p>
<p>Early access and free check requests: your email address, school or trust name, and
role, used to send you the check you asked for and occasional product updates. Lawful
basis: consent — you can withdraw it any time by unsubscribing or emailing us.</p>
<p>Subscriptions: your name, email and billing details are processed by Stripe, our
payment processor. We do not see or store your card number. Lawful basis: performance of
a contract. Stripe's own privacy notice applies to their processing.</p>
<p>Service records: publication dates and document links you record in the app, held to
provide the service.</p>

<p><strong>What we do not do.</strong> We do not sell personal data, we do not run
third-party advertising or tracking cookies, and we do not collect data about pupils.</p>

<p><strong>Where data lives.</strong> The service is hosted on Render (EU region,
Frankfurt). Payments are processed by Stripe.</p>

<p><strong>Retention.</strong> Waitlist details are kept until you unsubscribe or ask us
to delete them. Account data is kept while you have an account and deleted within 90 days
of closure, except records we must keep for tax purposes.</p>

<p><strong>Your rights.</strong> You can ask for a copy of your data, correction,
deletion, or restriction of processing at any time by emailing
oli@parishinabox.co.uk. You also have the right to complain to the Information
Commissioner's Office (ico.org.uk).</p>
</div></section>`;

module.exports = { TERMS, PRIVACY };
