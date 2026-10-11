# Addy Duplicate Guard — implementation, evidence, overhead and bypass limits

Enforced SEARCH-FIRST / REUSE-FIRST for the `addy-agent` DSH preset. Written 2026-10-11 against DSH `0.2.1-alpha.2` / Node `v24.15.0`, on top of the unchanged Addy Agent v1.0.3 preset. Corrective repair **R1** (same day) fixed three reviewed defects — see §11; the generation marker `r1` is reported by `status` and the activation log.

The contract this implements is the one supplied in the request; this document is the deliverable it asks for: minimal implementation, evidence of enforcement, test results, performance overhead, and the bypass paths that remain.

## 1. What was added

| File | Kind | Purpose |
|---|---|---|
| [duplicate-guard-core.mjs](duplicate-guard-core.mjs) | new | Pure policy: path classification, symbol extraction, repository scan, shell/PTC mutation analysis, git-boundary detection. `node:` builtins only, so it is unit-testable without a host. |
| [duplicate-guard.mjs](duplicate-guard.mjs) | new | The preset-scoped Cordis plugin `addy-duplicate-guard`: pre-execute gate, monotonic guard, post-edit recheck, git-boundary validation, and the `addy_duplicate_guard` tool. |
| [cordis.patch.yml](cordis.patch.yml) | 2 lines added | The guard is mounted as the **last row** of `preset-addy-agent.plugins`. |
| [package.json](package.json) | 2 entries added | `exports["./duplicate-guard"]` and `exports["./duplicate-guard-core"]` so the row name resolves; both files added to `files`. |
| [tests/duplicate-guard-unit.mjs](tests/duplicate-guard-unit.mjs) | new | 13 policy and acceptance cases + a 1000-file scan benchmark. |
| [tests/duplicate-guard-runtime.mjs](tests/duplicate-guard-runtime.mjs) | new | 25 cases on real Cordis, real `dsh-tool-fs`, real `dsh-tool-pwsh`, a real git repository fixture and a real Node PTC subprocess. |
| [tests/duplicate-guard-preservation.mjs](tests/duplicate-guard-preservation.mjs) | new | Proves nothing else changed. |
| [tests/contracts-config.mjs](tests/contracts-config.mjs) | extended | Asserts the guard is the *only* added preset row and every pre-existing row is byte-identical in identity and order. |

Untouched: all 212 pinned upstream files, [adapter-v2.mjs](adapter-v2.mjs), [adapter-v1.mjs](adapter-v1.mjs), [core-v2.mjs](core-v2.mjs), [core.mjs](core.mjs), [index.mjs](index.mjs), [prepare.mjs](prepare.mjs), [upstream-manifest.json](upstream-manifest.json), the nine command definitions, the 25 skills and the four personas. The nine commands, 25 skills, personas, references and both additions to `package.json` are verified in [tests/duplicate-guard-preservation.mjs](tests/duplicate-guard-preservation.mjs) — see §6.

No model routing, no PTC presentation mode, no specialist concurrency, no result summarization and no other preset was changed.

## 2. Architecture and scope

The plugin registers no service, so it cannot leak into the preset's isolate realm and cannot affect the host composition. It declares `inject: ['tools','systemPrompt']` and mounts inside `preset-addy-agent.plugins`, which means:

- it activates only for sessions running the Addy Agent preset;
- `ctx.tools.guard(...)` lands in the layer keyed by the preset's scope key, and `ToolRuntime.guardReason` walks the calling agent's scope chain (`chainLayers(exec.agent)`, where the agent object *is* its own scope key — `AgentLoop` does `createScope(loopCtx, this)`);
- `ctx.on('tools/pre-execute', …)` is a scope-filtered listener admitted for exactly that chain;
- an agent that is not bound to the preset is unaffected — asserted, not assumed, in runtime cases A10 and B5.

Nested PTC calls reach the same pipeline: `run_code` sub-dispatches carry a `parent` token and run through `prepare → tools/pre-execute → guards → dispatch`, so a `tools.write(...)` inside a program is gated by the same rule as a direct `write`. Runtime case B1 proves it end-to-end through a real Node PTC subprocess.

## 3. Required behaviour, as implemented

| Contract requirement | Where it is implemented |
|---|---|
| 1. Search the repository and workspace packages for names, signatures, exports, callers and equivalent behaviour | `addy_duplicate_guard` action `preflight` runs `scanRepository` itself: it walks every production source file once and returns declarations (file:line:kind), a reference sample, and token-similarity candidates. Bounded by `maxFiles` 4000 / `maxBytes` 24 MiB / `maxFileBytes` 512 KiB, with `truncated`/`truncatedReason` reported so coverage is never overclaimed. |
| 2. Identify candidates and whether each can be reused, extended or composed | The tool returns every collision it found; the caller must record `candidates[]` (with `decision: reuse\|extend\|compose`) or `acknowledged[]` (with justification). A non-`new` decision without a candidate is rejected. |
| 3. Produce a decision record | The accepted record is persisted hash-addressed under [evidence/duplicate-guard/](evidence/duplicate-guard/) and returned with `recordId`, `task`, `intent`, `decision`, `revision`, `scope`, `symbols`, `declaredElsewhere`, `acknowledgedCollisions`, the full scan summary and the evidence path/SHA-256/byte count. Since R1 persistence is fail-closed: the record is written first and read back — stored byte length and SHA-256 must match — and the preflight is accepted, and the approval registered, only after that verification succeeds. On failure the tool returns a structured error preserving the original cause, registers nothing, and a retry is safe (each attempt writes a fresh hash-addressed file). |
| 4. Associate it with the repository revision and intended edit scope | `revision` is read from `git rev-parse HEAD` at preflight time; `scope` is normalized to repo-relative prefixes. Both are re-checked on every mutation. |
| 5. Permit implementation only after successful preflight | Layers 1–2 below. |
| 6. Recheck newly introduced functions after editing | `tools/post-execute` runs a recheck for every allowed function-introducing `write`/`edit`; raw-PTC and shell writes, which have no post-execute hook, must instead declare their symbols in advance. |
| "A valid scan permits new functionality" | Runtime A2. |
| "Ambiguous or potentially equivalent match requires explicit reasoning, not automatic rejection or automatic duplication" | A bare `decision: "new"` **fails** while an exact declaration exists (A1b); the same request with an `acknowledged[]` entry and justification is **accepted** (A1c). A merely similar name is reported and accepted (A3). |

### What is gated, and what is not

Gated: production source files (extension list in `PRODUCTION_EXT`) that a mutation would give a **new function-like declaration**.

Never gated: test and spec files, fixtures, snapshots, `*.d.ts`, config files, generated/minified files, docs, any non-source extension, any path under `node_modules`/`dist`/`build`/`coverage`/`vendor`/`target`/hidden directories, and any edit that introduces no new declaration (a body change, a value change, a rename, a deletion). Reads, searches, planning artefacts, test runs and skill loads are untouched. Runtime cases A5, A5b and B0 assert this.

## 4. Enforcement layers

1. **`tools/pre-execute`, prepended, async** — the policy gate. It decides before dispatch and returns a denial whose text names the file, the introduced functions, the missing/stale record and the exact call needed. Because it is prepended it can deny but never weaken a downstream decision.
2. **`ctx.tools.guard`, monotonic, synchronous** — the same decision, memoized per execution token, as a backstop no later listener can turn back into permission. A guard denial is final by construction ("guards have no allow result").
3. **`tools/post-execute`** — the automatic post-edit recheck: it re-extracts the introduced declarations, compares them against the accepted record and against the repository, and records `unacknowledged` collisions. Since R1 the recheck is **fail-closed**: an unexpected verification exception becomes an explicit `verification-failed` blocker — identifying the file and the introduced declarations, retaining the underlying error, visible through `status` — instead of a silent pass. Any recheck blocker denies `git commit`/`git push` until a later recheck of the same file and revision succeeds, the duplicate is removed, or the acknowledge procedure resolves it.
4. **Git-boundary validation** — on `git commit`/`git push` the guard runs one `git status` plus one `git diff -U0 HEAD`, extracts declarations from *added lines only* (so a moved function is not mistaken for a new one), and denies the commit if any introduction sits outside every accepted scope, or if a recheck blocker is unresolved.

The cache the contract asks for is the accepted record itself: `(agent, task) → {revision, scope, symbols, collisions, scan}`. A mutation is allowed when a record exists whose `revision` equals the current HEAD and whose `scope` contains the target path. Consequences:

- one preflight per implementation task per revision, not one per edit (A4b asserts `preflights` does not increase across three further edits);
- the cache is invalidated when a path falls outside the recorded scope, and when HEAD moves — including after a commit made through the shell tool, whose HEAD cache is invalidated in `tools/post-execute` rather than after a debounce (A6);
- the expensive repository search is never repeated for a harmless edit, because a harmless edit is not gated at all.

## 5. Test results

All suites were run in isolated processes with deterministic fixtures. No LLM request was made, so nothing here claims production-model compliance.

| Suite | Cases | Result | Evidence |
|---|---|---|---|
| [tests/duplicate-guard-unit.mjs](tests/duplicate-guard-unit.mjs) | 15 (13 + 2 R1 regressions) | pass | [duplicate-guard-unit.json](evidence/duplicate-guard-unit.json) |
| [tests/duplicate-guard-runtime.mjs](tests/duplicate-guard-runtime.mjs) | 34 (26 + 8 R1 regressions) | pass | [duplicate-guard-runtime.json](evidence/duplicate-guard-runtime.json) |
| [tests/duplicate-guard-preservation.mjs](tests/duplicate-guard-preservation.mjs) | 5 | pass | [duplicate-guard-preservation.json](evidence/duplicate-guard-preservation.json) |
| [tests/contracts-config.mjs](tests/contracts-config.mjs) | 4 | pass | [contracts-config.json](evidence/contracts-config.json) |
| Existing suites (`core.test.mjs`, `compact-results.test.mjs`, `contracts-runtime.mjs`, `native-runtime.mjs`, `native-scoped-specialists.mjs`, `native-cancellation.mjs`, `native-ptc.mjs`) | unchanged | pass, re-run after the change | [evidence/](evidence/) |

### Acceptance-case map

| Required case | Runtime case | Observed |
|---|---|---|
| New function where an equivalent exists | A1, A1b, A1c, A1d | Denied before the write with the existing declaration named; a bare `new` decision is rejected; explicit acknowledgment is accepted; the same write then succeeds. |
| New function where no equivalent exists | A2 | Clean scan, accepted, write reaches disk. |
| Different function with a similar name | A3 | `parseConfigFile` vs the existing `parseConfig` reported as a similarity candidate (score ≥ 0.5), zero equivalent declarations, accepted, written. |
| Legitimate extension or composition | A4, A4b, A5b | `decision: compose` with a candidate record authorises a composition helper; three further edits in the same task cost zero extra preflights; a body-only edit needs no evidence at all. |
| Multiple edits within one approved task | A4b | Three edits, `preflights` delta 0. |
| Missing or stale discovery evidence | A6 | First write denied with "No discovery evidence exists"; after an approved revision is committed, the next introduction is denied as stale with both revisions named. |
| Nested PTC source mutation | B1, B2 | `tools.write` inside a real `run_code` program is denied by the same rule; after a preflight through the PTC binding the same nested write succeeds. |
| Shell-based source mutation / attempted bypass | A7, A11, B3, B3b, B4 | `Set-Content` and redirection denied with the file never created (a real `dsh-tool-pwsh` runs the tool, so the body provably never executed); an approved shell write succeeds; direct `node:fs` and `child_process` PTC writes are denied before the program starts, and permitted once their declarations are declared. |
| Subsequent Git commit validation | A8, A9 | A production function introduced outside the tool pipeline is caught at the boundary and the commit is refused with HEAD unmoved; a post-edit recheck blocker refuses the commit until acknowledged, then allows it. |
| Existing Addy commands and workflows unchanged | preservation + config suites | 212/212 upstream digests, 9 commands, 25 skills, 4 personas, both adapter generations byte-identical, the guard is the only added preset row and is appended last. |

### R1 corrective-regression map

| Required R1 test | Case | Observed |
|---|---|---|
| 1. Absolute-path body-only edit allowed without preflight | R1 | Body-line edit, whole-file body rewrite and signature edit of `existing()` via absolute path all ungated; `status` shows 0 records for those edits. **Pre-fix this case failed**: `blocked write → src/util.mjs: it introduces new production function(s): existing (src/util.mjs:1)`. |
| 2. Relative-path equivalent edit — identical decision | R1 | Both forms allowed; for a gated new declaration the two denial texts are asserted byte-identical. |
| 3. Absolute-path new declaration correctly gated | R1, B6 | Denied with the standard missing-evidence reason; after one preflight naming the absolute target, the absolute-path write (direct and nested-PTC) succeeds; a body-only rewrite of that file stays ungated. |
| 4. Path outside repository — existing safety behavior | R2 | Guard passthrough unchanged (no ADDY-DUPLICATE-GUARD denial). |
| 5. Evidence directory unwritable — preflight rejected | R4 | Real `EEXIST` failure (a file placed at the configured `evidenceDir`): structured rejection, cause preserved. |
| 6. Evidence persistence throws — no approval registered | R4 | `status.records` is 0 and the protected write stays denied with the file never created. |
| 7. Evidence read-back/hash mismatch — no approval registered | unit "defect 2" + R4 | Corrupted and truncated read-backs both throw (`evidence verification failed…`) and the corrupt file is removed; the plugin registers approvals only after `persistEvidenceRecord` returns, proven end-to-end by R4's real write failure through the same path. |
| 8. Successful evidence retry — approval accepted | R5 | Storage fixed → same preflight accepted; stored bytes and SHA-256 independently re-verified by the test; the mutation is authorised; a repeated preflight writes a fresh record. |
| 9. Post-edit recheck throws — explicit blocker | R6 | Injected failure → one `verification-failed` blocker naming file, introduced symbols and the underlying error; `overhead.recheckFailures` counted. |
| 10. Commit/push with unresolved blocker — denied | R6 | Both denied with the failed-recheck line; HEAD verified unmoved. |
| 11. Successful recheck resolution — blocker cleared | R8 | Fault cleared → `action:"recheck"` returns `status:'verified'`, blockers 0, commit proceeds. |
| 12. Exempt edits and read-only operations unaffected | R7 (+ A5, A5b, B0) | Test-file write, read and body-only edit never reach the recheck path (the injector never sees them) and create no blockers. |

## 6. Preservation evidence

- `verifyIntegrity()` re-verifies all **212** manifest-tracked files on every activation; [upstream-manifest.json](upstream-manifest.json) is itself byte-identical to the pre-change digest `62128b77…`, which makes the chain transitive.
- The pinned tree digest over the 212 tracked files (excluding the nested `upstream/.git` checkout) is recorded in [duplicate-guard-preservation.json](evidence/duplicate-guard-preservation.json). The newest mtime under `upstream/` is asserted to be older than the files this change edited.
- Every watched file except `package.json` and `cordis.patch.yml` is byte-identical to its pre-change SHA-256; those two are the complete set of modifications, and the config suite asserts the guard row is appended after all 22 pre-existing rows so no row was reordered, renamed or reconfigured.

## 7. Performance overhead

Measured in the runtime suite. "Guarded vs unguarded" runs the **same** operation on two real agents in one host: one bound to the preset scope (guard active), one outside it.

| Operation | Guarded p50 | Unguarded p50 | Delta |
|---|---|---|---|
| `read` of a production file | 2.33 ms | 2.14 ms | **+0.20 ms** |
| `write` of a test file (exempt) | 6.65 ms | 6.03 ms | **+0.62 ms** |
| `edit` of a value, no new function | 9.66 ms | 10.49 ms | **−0.83 ms** (noise) |
| read-only `pwsh` command | 431.9 ms | 406.9 ms | +25 ms — Windows `pwsh` process startup dominates; run-to-run spread on this row is ±6 %, and the guard's own contribution is `shell-ungated` below |

Guard-only costs, from the plugin's own per-class instrumentation (`overhead.byKind`):

| Class | Count | Total | Worst single |
|---|---|---|---|
| `untracked-tool` (a tool the guard does not track) | 33 | 0.101 ms | 0.031 ms |
| `fs-ungated-path` (test/doc/non-source path) | 10 | 0.334 ms | 0.061 ms |
| `fs-no-new-function` (harmless edit) | 12 | 6.019 ms | 0.586 ms |
| `fs-mutation-unapproved` (denied) | 11 | 103.801 ms | 52.12 ms (first call, cold `git rev-parse HEAD`; p50 0.62 ms) |
| `fs-mutation-approved` | 19 | 3.495 ms | 0.55 ms |
| `shell-ungated` | 8 | 0.463 ms | 0.106 ms |
| `shell-mutation-unapproved` | 2 | 0.849 ms | 0.797 ms |
| `shell-mutation-approved` | 1 | 0.103 ms | 0.103 ms |
| `git-boundary-approved` + `-denied` | 6 | 380.737 ms | 72.386 ms |
| **All 95 evaluations** | 95 | 861.564 ms | — |

End-to-end costs that include the operation itself:

| Operation | p50 | p95 |
|---|---|---|
| Production write, denied (no evidence) | 0.62 ms | 26.0 ms |
| Preflight, small fixture | 7.1 ms | 8.8 ms |
| Production write, all introduced symbols declared | 7.3 ms | 8.1 ms |
| Production write, undeclared symbol forces a postcheck scan | 15.3 ms | 17.2 ms |
| `git add` + `git commit`, including boundary validation | 651.7 ms | 651.7 ms (real Windows git processes; the guard contributes ≤ 72 ms) |

Preflight cost is dominated by reading every production source file, not by parsing:

- synthetic repository, **1000 files / 2.3 MiB / 25 000 declarations**: p50 **496 ms**, max 544 ms. Phase profiling shows 437 ms of that is `readFileSync` on 1000 files (≈0.44 ms/file on this Windows volume) and only ≈10 ms is symbol extraction. Cost is therefore I/O-bound and proportional to repository size, capped by `maxFiles`/`maxBytes`, and paid once per implementation task per revision.
- The Git-boundary check was optimised during this work from one `git show` per changed file (854 ms) to one `git status` + one `git diff -U0 HEAD` (≤ 72 ms), and now reads added lines only.

## 8. Remaining bypass limitations

The policy is enforced on the **paths DSH can observe**. The following are known and are stated rather than papered over. Items marked *(commit-visible)* are still caught by layer 4 — as an introduction outside every accepted scope — but the edit itself is not blocked.

1. **Runtime-assembled paths (commit-visible).** A shell command or PTC program that builds a production path from fragments (`["src/", "a", ".ts"].join("")`) exposes no literal `X.ext` token, so layers 1–3 do not gate it. Unit case "acceptance 7" asserts this hole explicitly.
2. **Script-file indirection (commit-visible).** `pwsh build.ps1` or `node scripts/codegen.mjs` where the script performs the write contains neither a write construct nor a production path.
3. **In-repo generators (commit-visible).** `npm run generate`, `make`, `tsc`-emit and similar tools write sources without naming them.
4. **Formatter-class tools. `npx prettier --write src/a.ts` is deliberately not gated** because it cannot introduce a declaration. A fixer that *can* add code (`eslint --fix` with a rule that inserts functions, codemods) is in the same class as items 2–3.
5. **Commits made outside the agent's shell tool.** Layer 4 runs on `git commit`/`git push` issued through `pwsh`/`bash`. A commit from an external terminal, IDE or another DSH session is not validated. The honest claim is therefore: *no production function reaches a commit **made through the agent's shell tool** without either an accepted revision-bound discovery record for that path or an explicit acknowledgment.*
6. **Non-git workspaces.** Without a repository, `revision` is recorded as `null`, records never expire, and both the boundary layer and the staleness check are absent.
7. **Symbol extractor is a heuristic, not a parser.** It covers JS/TS/JSX/Vue/Svelte/Astro, Python, Go, Rust, Kotlin, Swift, Ruby, PHP, Java/C#/Scala/Dart and C/C++ function forms; it strips comments and strings and skips declaration keywords. Missed forms include `obj.method = function () {}`, `define(...)`, preprocessor- or macro-generated declarations, Python lambdas, C++ operator overloads, and any language not in the list. A missed declaration is not gated.
8. **Scope-level caching is not symbol-level pre-authorisation for fs writes.** An accepted record authorises any declaration inside its scope at its revision. A `write`/`edit` may therefore introduce a function that the record did not name; the post-edit recheck detects a same-name collision elsewhere and blocks the commit until acknowledged, but it does not block the edit. Raw-PTC and shell writes are stricter here: their declarations must be named in advance because no recheck hook exists for them.
9. **Evidence is per host process.** Records live in memory for the session's lifetime; restarting the host loses them and the model must re-run the preflight (fail-closed, not fail-open). The hash-addressed JSON under [evidence/duplicate-guard/](evidence/duplicate-guard/) is the durable audit trail.
10. **The recheck is reported, not reverted.** A duplicate found after an edit is recorded and blocks the commit; the guard does not delete the code it already allowed. Reverting is the caller's decision.
11. **No filesystem sandbox.** A process outside DSH — another terminal, another agent host, a background job started earlier — can write to the repository. Layers 1–3 are preventive heuristics with the holes above; layer 4 is detection at the commit boundary.
12. **Deliberately ungated revert verbs.** `git restore`/`git checkout -- <path>` are not treated as writes: they can only move content back toward HEAD. `git checkout <other-branch>` is not gated either, and any resulting introduction is caught at the boundary.
13. **Tool-body failures are not reverted.** A denial prevents dispatch: runtime case A7 asserts that both the `Set-Content` target and the redirection target do not exist afterwards, and A8 asserts HEAD did not move after a refused commit. A guard cannot, however, undo a write performed by a tool that was already allowed.
14. **Fail-closed on internal error.** If the guard itself throws while evaluating a source-mutation tool, the call is denied with an explicit message rather than allowed. This is a deliberate availability/security trade-off; `overhead.failures` is 0 across all recorded runs.

## 9. Running it

```powershell
node tests/duplicate-guard-unit.mjs
node tests/duplicate-guard-runtime.mjs
node tests/duplicate-guard-preservation.mjs
node tests/contracts-config.mjs
```

`ADDY_DUPLICATE_GUARD_DISABLED` is not honoured — the plugin has no environment off switch by design. To disable it, either remove the `addy-duplicate-guard` row from [cordis.patch.yml](cordis.patch.yml) or set `enabled: false` in that row's `config` (the row then registers no listener and no tool). Reversal: deleting the row and the two module files restores the preset to its v1.0.3 composition exactly; no other file was modified (see §6).

## 10. Known-good configuration knobs

The row accepts an optional `config`. Defaults are shown; all are optional.

```yaml
- id: addy-duplicate-guard
  name: '@local/dsh-addy-agent/duplicate-guard'
  # config:
  #   enabled: true
  #   productionPaths: []        # restrict the policy to these prefixes
  #   exemptPaths: []            # additional non-production prefixes
  #   evidenceDir: <package>/evidence/duplicate-guard   # where verified decision records are persisted (R1)
  #   scan:        { maxFiles: 4000, maxBytes: 25165824, maxFileBytes: 524288, maxRefsPerName: 25 }
  #   postcheckScan: { maxFiles: 2500, maxBytes: 12582912, maxFileBytes: 524288, maxRefsPerName: 5 }
  #   __testForceRecheckError: <function>  # TEST-ONLY fault seam (R1): invoked with the pending entry
  #                                        # before each automatic post-edit recheck; an Error it
  #                                        # returns is thrown in place of the recheck to exercise
  #                                        # the fail-closed path. Inert unless explicitly configured;
  #                                        # no shipped composition row sets it.
```

## 11. R1 corrective repair (2026-10-11)

Bounded repair of exactly three reviewed defects. Files changed: [duplicate-guard.mjs](duplicate-guard.mjs), [duplicate-guard-core.mjs](duplicate-guard-core.mjs), [tests/duplicate-guard-runtime.mjs](tests/duplicate-guard-runtime.mjs), [tests/duplicate-guard-unit.mjs](tests/duplicate-guard-unit.mjs), and documentation (`DUPLICATE-GUARD.md`, `README.md`, `VERIFICATION.md`). `package.json`, `cordis.patch.yml`, the version (`1.0.3`), all pinned upstream files and both adapter generations are untouched — verified byte-wise by the preservation suite after the repair.

**Defect 1 — absolute-path normalization.** Before: `decideFs` normalized the target to a repo-relative path for classification but `analyzeFsMutation` re-derived its own path from the raw arguments, so the file reader received `join(root, 'C:/…')` — an invalid path — reported the file as absent, and counted every existing declaration as newly introduced (an ordinary body edit via absolute path was gated; approved absolute-path writes also over-reported introduced symbols into the recheck). After: the normalized repo-relative representation is computed exactly once and passed to the analysis (`call.rel`); every read and report uses that single value. Relative and absolute inputs for the same file now produce byte-identical decisions (R1, B6); genuinely new declarations remain gated; the outside-repository passthrough is unchanged (R2).

**Defect 2 — fail-closed evidence persistence.** Before: the approval was registered in memory first and `saveEvidence` swallowed failures, so a preflight could return `accepted: true` with `evidence.path: null`; the acknowledge path was worse — its record has no `task`, so `record.task.replace(…)` threw and its evidence was *never* persisted. After: persistence moved to `persistEvidenceRecord` in the core, which writes, reads back, and verifies stored byte length and SHA-256 (removing a corrupt record so a retry cannot collide), and only then does the preflight register the approval and return `accepted: true` referencing the verified record. A persistence or verification failure returns a structured rejection preserving the original cause, registers nothing, authorizes nothing, and is safe to retry (each attempt is a fresh hash-addressed file). Acknowledge follows the same order: resolution evidence is verified before any blocker is marked resolved. The serialized evidence format is unchanged; the filename label falls back `task → kind → 'record'` (R4, R5, unit "defect 2").

**Defect 3 — fail-closed post-edit recheck.** Before: the post-execute recheck ran inside `catch {}`, so an unexpected exception vanished — verification was incomplete yet nothing blocked the commit. After: any exception becomes an explicit unresolved `verification-failed` blocker recording the file, the introduced declarations of the affected edit and the underlying error; it is visible through `status` (and counted in `overhead.recheckFailures`), and denies agent-mediated `git commit`/`git push` until a recheck of the same file and revision succeeds (replacing the record) or the acknowledge procedure resolves it. The requirement only applies to protected production edits that required duplicate checking — exempt test writes, reads and ungated body edits never enter the recheck path (R6, R7, R8). To make this path testable at all, the row config gained the documented test-only fault seam `__testForceRecheckError` (inert unless configured); the success record now also carries `status: 'verified'` so the two outcomes are explicitly distinguishable.

Nothing else changed: approval semantics, caching/invalidation, scope rules, the four enforcement layers, the bypass list in §8 and the performance profile (§7, re-measured: benchmark p50 487 ms vs 496 ms pre-repair, ungated deltas unchanged) are preserved. All ten suites pass after the repair (15 + 34 + 5 + 4 guard/config cases; the seven pre-existing Addy suites unchanged), upstream integrity re-verified at 212/212, and existing evidence files were preserved (suites regenerate only their own outputs and append new hash-addressed records).
