# Addy runtime fixture

Synthetic local-only review subject. No deployments, credentials, network or real users.

Test: `node --test api.test.mjs`.

The current synthetic change intentionally introduces unsafe evaluation, an unbound query, and a failing expected test value. It is designed to produce a NO-GO review, not to be shipped.

The compute and lookup functions are exercised as API helpers by untrusted caller input. Auth middleware, migrations, monitoring, feature flags and production environment configuration are absent; treat these as unknown or not applicable, not verified deployed infrastructure.
