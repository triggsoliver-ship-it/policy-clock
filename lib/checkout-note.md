# Currency at checkout

Stripe's **Adaptive Pricing** is on by default for new accounts. It converts the
price into the currency Stripe guesses from the customer's location, so a UK
school business manager could be shown `US$54.42` with a small GBP toggle,
instead of the £39 they read on the pricing page.

That is bad for a UK-only product: the price on the landing page must be the
price at checkout, or people abandon.

We turn it off **per Checkout Session** with:

    adaptive_pricing[enabled]=false

rather than relying on the account-level dashboard toggle, because:

1. The per-session parameter is explicit in the code, so it cannot be undone by
   someone changing an account setting later.
2. The account-level toggle in the Stripe dashboard proved unreliable to set
   (the confirmation dialog repeatedly failed to persist on 31 Jul 2026).

If you ever do sell outside the UK, remove the parameter rather than adding a
second currency — Stripe handles the conversion better than we would.

## Managed Payments (found broken in production, 1 Sep 2026)

From some point after 31 Jul 2026, Stripe rejected **every** Checkout Session this
app created, on all three tiers, with:

> `adaptive_pricing[enabled]` must be `true` when Managed Payments is enabled.
> Omit this parameter or pass `adaptive_pricing[enabled]=true`. ... you can
> disable it for this request by passing in `managed_payments[enabled]=false`.

Managed Payments is on by default on the account, and it is incompatible with
switching Adaptive Pricing off. The result was a `502 Stripe rejected that` page
for anyone who pressed "Start free 30 day trial" — the product could not take a
single payment while outreach was running against it.

Fixed by sending both parameters together:

    managed_payments[enabled]=false
    adaptive_pricing[enabled]=false

Keep them together. Dropping only `adaptive_pricing` brings back dollar pricing;
dropping only `managed_payments` brings back the 502.
