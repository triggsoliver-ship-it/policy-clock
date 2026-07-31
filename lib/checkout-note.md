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
