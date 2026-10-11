# Bounded repair: compact result projections

Date: 2026-10-11. Bundle version: `1.0.3` (previous `1.0.2`).

**Scope:** Adapter code only (`core-v2.mjs`, `adapter-v2.mjs`), deterministic regression tests, and associated package documentation. All 212 original upstream assets and the Addy command definitions are unchanged. The Cordis preset composition is unchanged.

## Defect and correction

1. `organize()` intentionally retains complete specialist reports both as `reports` and `groups.byAgent` inside persisted evidence. Previously `concise()` discarded `reports` but leaked them through `groups.byAgent`. It now replaces `groups.byAgent` **in concise output only** with arrays of `/reports/<index>` pointers; full evidence remains untouched.
2. `addy_specialists` previously re-added raw `reports` beside its concise response. It no longer does so. Both it and `addy_results` return a compact summary, the `fullResult` file path, SHA-256 digest and byte size, and per-specialist pointers.
3. The parent agent must load the unabridged reports from `fullResult.path` before carrying out Addy's original `/ship` synthesis and reproducing full specialist reports in its final answer. The concise output does **not** supersede those requirements; it saves redundant intermediate tool-result text, not necessarily the full end-to-end token cost.

## Verification

Run `node --test tests/core.test.mjs tests/compact-results.test.mjs` (portable, no DSH installation required). The new tests check source report bytes, original evidence SHA-256, per-agent pointers, zero leaked report markers, both adapter return shapes, counting/deduplication, and an asserted reduction in model-facing output size using a fixed large-report fixture.

The original native host and real-provider tests in `VERIFICATION.md` describe version `1.0.2`; they **have not been rerun** for this patched artifact. No installed profile, provider, model route or preset was changed. Replacing a loaded local module may require a clean DSH process restart and a fresh session; perform host acceptance testing before relying on version `1.0.3` operationally.

## Reversal

Keep a backup of `1.0.2`. If this projection breaks full-report retrieval in the live host, restore the original bundle and restart DSH. The saved evidence is not changed by this patch.
