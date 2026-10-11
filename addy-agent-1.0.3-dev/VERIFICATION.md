# Verification — `@local/dsh-addy-agent`

All numbers below were produced on 2026-10-11 with Node v24.15.0 and DSH 0.2.1-alpha.2 (installed native packages) against the pinned upstream revision `1be8e34187e34647bb83adc3a1323b26ae6f6abe`. Evidence files live in [evidence/](evidence/).

## 1. Upstream integrity

[upstream-manifest.json](upstream-manifest.json) lists all 212 tracked upstream files with Git blob and SHA-256 digests. `verifyIntegrity()` re-verifies every digest each time the preset activates. Result: **212/212 verified** in every run recorded below. Runs from [tests/core.test.mjs](tests/core.test.mjs), [tests/contracts-runtime.mjs](tests/contracts-runtime.mjs), and [tests/contracts-config.mjs](tests/contracts-config.mjs) all confirm it.

## 2. Deterministic native contract suites (no real LLM calls)

| Suite | What it proves | Result |
|---|---|---|
| [tests/core.test.mjs](tests/core.test.mjs) | 212 digests, 9 command sources + verbatim arguments, 25 skill bodies/resource dirs, build/constraints mode dispatch, duplicate-side-effect retention, per-branch persona-load and cleanup-failure retention | 6/6 pass — [evidence immaterial, assertions inline] |
| [tests/contracts-runtime.mjs](tests/contracts-runtime.mjs) | Real cordis Context + session/agent/tools/skills/commands/system-prompt/agent-loop services: per-agent command registration, outsider isolation, native skill-tool byte fidelity for all 25 skills, scoped routing section, each `/x` slash handler queueing the byte-identical original instructions via the real Commands.execute → AgentLoop followup path with raw whitespace argument preservation, specialist delegation denial via the real restrict/guard primitives | 14/14 pass — [contracts-runtime.json](contracts-runtime.json) |
| [tests/contracts-config.mjs](tests/contracts-config.mjs) | Patch YAML inserts exactly one preset (`addy-agent`), PTC presentation mode, isolated workflow group with `maxConcurrentAgents: 3`, pinned manifest integrity | 2/2 pass — [contracts-config.json](contracts-config.json) |
| [tests/native-runtime.mjs](tests/native-runtime.mjs) | `/ship` fan-out through real native child Agents: success (3 started/3 completed) and one-provider-failure (3/2/1, `incomplete: true`); exact original persona system requests (bundled fallback; host `USERPROFILE` isolated); nested-delegation deny schemas; direct `subagent`/`workflow` execution denied | pass — [native-runtime.json](native-runtime.json) |
| [tests/native-scoped-specialists.mjs](tests/native-scoped-specialists.mjs) | Child-local (preset-mounted) delegation tools, which cannot be hidden by the global restriction API, are denied at execution by the exact-child monotonic guard — 9/9 probes denied, zero unexpected executions, 3 real concurrent children | pass — [native-scoped-specialists.json](native-scoped-specialists.json) |
| [tests/native-cancellation.mjs](tests/native-cancellation.mjs) | Caller cancellation of started children disposes and drains all three owned activations; reports retained as failed with 3/0/3 and `incomplete: true` | pass — [native-cancellation.json](native-cancellation.json) |
| [tests/native-ptc.mjs](tests/native-ptc.mjs) | Real Node PTC subprocess: 5 nested tool calls (4 unique, 1 duplicate), duplicate side effects actually execute twice, preserved failure detail, observed concurrency cap | pass — [native-ptc.json](native-ptc.json) |

Every suite ran in an isolated process with a deterministic test-only LlmAdapter; the configured provider, profile, and presets were not touched.

## 3. Installed-host live verification (real configured provider)

A temporary verifier bundle (`@local/dsh-addy-verifier`, plain module, no model routing of its own) was installed in the live restarted host, drove three fresh disposable Addy sessions against a synthetic safe fixture ([tests/live-fixture](tests/live-fixture), its own git repo, commit `92fb413`: unsafe `eval`, unbound query, intentionally failing test — deliberately a NO-GO subject), then was fully removed. The real session model (`gpt-6.1-sol` at the time of the run) executed everything. Results — [live-summary.json](live-summary.json), full capture [live-accepted.json](live-accepted.json) (6,759,232 bytes, SHA-256 `ec92b29e…`):

| Requirement | Result |
|---|---|
| Installed preset scope: 9 commands, 25 skills, 3 adapter tools, 22 preset plugins | pass |
| Actual Node PTC presentation + nested `run_code` dispatch of `addy_command` and `skill` with byte/argument roundtrip fidelity, adapter generation 2 confirmed | pass |
| Direct model call `addy_command` collapsed by PTC mode (`UNKNOWN_TOOL: only run_code callable`) | pass |
| Scoped isolated native `workflowEngine` (parallel helpers, no model calls) | pass |
| Natural-language review request routed to the original `/review` source by the real model | pass |
| Explicit `/ship` initiated real concurrent specialist fan-out: 3 attempted / 3 started / 3 completed / 0 failed, three actual overlapping child LLM streams (5.307 s overlap, `maximumConcurrentChildStreams: 3`) | pass |
| Nested delegation denied inside all three children via the exact Addy guard message; `spawn_teammate`/`team_task_create` absent from child surface | pass (recomputed — see §6) |
| Default model selection unchanged before/after (`gpt-6.1-sol`, later user switch to `glm-5.3-flash` outside the preset) | pass |
| Final parent report: `NO-GO` verdict, rollback triggers, procedure, RTO present | pass |

Full reports produced during the run: [live-parent-ship-report.md](live-parent-ship-report.md), [live-code-reviewer-report.md](live-code-reviewer-report.md), [live-security-auditor-report.md](live-security-auditor-report.md), [live-test-engineer-report.md](live-test-engineer-report.md). Two earlier partial captures ([live-installed-v2.json](live-installed-v2.json), [live-installed-v3.json](live-installed-v3.json)) are retained; v3 exposed the child-restrict bug that motivated the guard fix and v4 confirms it fixed.

Observed during that window and remediated before the passing run:

1. Child-scope `tools.restrict({deny:[name]})` rejects preset-local tool names (they are not globals), so specialists failed to start — the deny list is now applied as an exact-child monotonic `tools.guard`, plus best-effort restrict only for names the global registry actually knows (adapter generation 2, confirmed live via `adapterGeneration: 2`).
2. Accepted child work was not covered by the caller signal alone — callers now explicitly dispose and drain native activations on cancellation; persona-load and cleanup failures are retained without discarding sibling reports.

## 4. Existing-configuration preservation

- Profile patch [cordis.patch.yml](../../../../../.dsh/profiles/web/cordis.patch.yml) before install: SHA-256 `e35b76ce…` ([before-install.json](evidence/before-install.json)). After everything: `a7ce8bed…`. The complete diff against the pre-install baseline is exactly one model-route entry (`provider/model/reasoningEffort`: `openai-codex/gpt-6.1-sol/medium` → `opencode-go/glm-5.3-flash`) reflecting this interactive session's own model switch; zero addy-related rows and zero preset-selection changes. Bundle manifests are stored in plugin-manager metadata, not in the profile patch.
- Preset roster before/after identical: `standard`, `ptc`, `ptc-skills`, `minimal`, `cordis`, `addy-agent` (added) — no edits elsewhere; profile default selection still `ptc-skills`.
- No provider/model settings were read for modification at any point (`agentDefaultModel.currentSelection()` only read for comparison).

## 5. Reversal (rollback of the install)

Copy-safe, additive, stored outside DSH:

1. Plugin Manager → disable or remove bundle `@local/dsh-addy-agent` (`plugin_manager` action `set_bundle`/`remove_bundle`), or `pnpm remove @local/dsh-addy-agent` in `C:\Users\GNV\.dsh\profiles\web`; old sessions keep their already-composed revision until restart.
2. Nothing else to revert: the profile patch, settings.yaml, model routes and defaults were never written by the installer; the upstream tree is read-only inside the package. Temporary fixture/verifier sources remain under `tests/` of the package and are inert unless the verifier bundle is explicitly reinstalled.

To fully audit a rerun: `pnpm install` the linked module, then follow §2 suite order via `node tests/contracts-config.mjs`, then `node tests/contracts-runtime.mjs`, then the remaining `tests/native-*.mjs` files (Node 24+, no network needed except npm linkage).

## 7. Duplicate guard (added 2026-10-11, after §1–§6)

The `addy-duplicate-guard` plugin was added as the last row of `preset-addy-agent.plugins`, with its own full report in [DUPLICATE-GUARD.md](DUPLICATE-GUARD.md). Both composition files it needed are the *only* files that differ from the pre-change baseline.

| Suite | Cases | Result | Evidence |
|---|---|---|---|
| [tests/duplicate-guard-unit.mjs](tests/duplicate-guard-unit.mjs) — policy, all ten acceptance cases at policy level, 1000-file scan benchmark | 13 | pass | [duplicate-guard-unit.json](evidence/duplicate-guard-unit.json) |
| [tests/duplicate-guard-runtime.mjs](tests/duplicate-guard-runtime.mjs) — real Cordis, real `dsh-tool-fs`, real `dsh-tool-pwsh`, real git fixture, real Node PTC subprocess, preset-scope binding | 26 | pass | [duplicate-guard-runtime.json](evidence/duplicate-guard-runtime.json) |
| [tests/duplicate-guard-preservation.mjs](tests/duplicate-guard-preservation.mjs) | 5 | pass | [duplicate-guard-preservation.json](evidence/duplicate-guard-preservation.json) |
| [tests/contracts-config.mjs](tests/contracts-config.mjs) — extended to assert the guard is the only added row | 4 | pass | [contracts-config.json](evidence/contracts-config.json) |

Preservation after the change: `verifyIntegrity()` still reports **212/212**; `upstream-manifest.json`, `adapter-v2.mjs`, `adapter-v1.mjs`, `core-v2.mjs`, `core.mjs`, `index.mjs` and `prepare.mjs` are byte-identical to their pre-change SHA-256; the only differing watched files are `package.json` and `cordis.patch.yml`; the nine commands, 25 skill bodies and four personas are unchanged; and the guard row is appended after all 22 pre-existing rows so none was reordered or reconfigured. All seven pre-existing suites were re-run after the change and still pass.

Guard overhead measured against the same operations on an agent outside the preset scope: **+0.20 ms** for a read, **+0.62 ms** for an exempt test-file write, **−0.83 ms** (noise) for a value edit, and ≤ 0.11 ms for any tool the guard does not track. A denied production write is 0.62 ms at p50; an accepted one is 7.3 ms at p50 (15.3 ms when a post-edit recheck has to rescan); the git-boundary check contributes ≤ 72 ms; the once-per-task repository scan is I/O-bound at 496 ms for a synthetic 1000-file / 2.3 MiB repository. Per-class numbers and the fourteen documented bypass limitations are in [DUPLICATE-GUARD.md §7–§8](DUPLICATE-GUARD.md).

Honesty notes for this section: the runtime suites use deterministic fixtures and make **no LLM request**, so they prove enforcement mechanics, not production-model compliance. Shell cases run the real `dsh-tool-pwsh`, so a denial is proven by the absent file rather than by a stub. The guard's symbol extractor is a documented heuristic, not a parser, and the paths it cannot observe are enumerated rather than claimed as covered.

### 7b. R1 corrective repair (2026-10-11, same day)

Three reviewed defects in the guard were repaired without touching anything else: absolute-path normalization (an absolute `file_path` made the guard's reader miss the existing file, so body-only edits were mis-gated and existing functions appeared newly introduced), fail-closed evidence persistence (a preflight could report `accepted: true` with unpersisted evidence; acknowledge evidence was silently lost on a `record.task.replace` throw), and fail-closed post-edit recheck (an unexpected recheck exception was swallowed without creating a blocker). Full before/after detail: [DUPLICATE-GUARD.md §11](DUPLICATE-GUARD.md).

Post-repair verification: **all ten suites pass** — guard suites grew to 15 unit cases (+2 defect regressions), 34 runtime cases (+8: R1/R2 path equivalence incl. nested PTC B6, R4/R5 evidence fail-closed and verified retry, R6–R8 recheck-failure blocker → commit/push denial → resolution), 5 preservation cases, 4 config cases; the seven pre-existing Addy suites are unchanged and green. The defect-1 regression was demonstrated **red before the fix** through the real tool pipeline (`blocked write → src/util.mjs: it introduces new production function(s): existing (src/util.mjs:1)`) and green after. Upstream integrity re-verified **212/212**; `adapter-v1/v2`, `core`, `core-v2`, `index`, `prepare`, `upstream-manifest.json`, `cordis.patch.yml` and `package.json` are byte-identical to their recorded digests (R1 changed only the two guard modules, three test files and documentation); 9 commands, 25 skills, 4 personas preserved; existing evidence files preserved (suite-owned outputs regenerate by design; hash-addressed records only append). Scan benchmark unchanged (p50 487 ms vs 496 ms on the 1000-file fixture). The plugin now reports generation `r1` via `status` and its activation log for stale-module detection. These remain deterministic test results, not real-model behavioral verification.

## 8. Honesty annotations

- The nested-delegation case in §3 was **recomputed** from the retained raw denial payloads under a corrected verifier predicate (the initial run flagged `pass:false` because the predicate required the identical guard message even for tools simply absent from the child surface; raw evidence shows `subagent` guard-denied and the other two absent — both satisfy "no nested delegation", and nothing mis-executed). The recomputation is flagged (`recomputed: true`) in the summary; the original bytes are preserved unchanged.
- `counts.nativeErrors: 8` includes the intentional denial probes recorded by the observer; original tool results were NOT rewritten to equate clean shell exit codes with unexpected failures.
- No claim is made that the model obeyed every upstream human-approval gate: spec/plan/risk sign-offs were not exercised here (non-UI fixture); §3 covers review + ship only. `/webperf` measurement paths were out of scope.
- `/ship`'s rollback plan was produced by the tested parent, not executed: no deployment happened, nothing to roll back.
- The three live child streams ran to completion with a real provider; elapsed overlap numbers are actual timestamps, not projection.

## 9. Residual gaps (documented, not silently dropped)

- Optional upstream Bash hooks (SDD-cache, simplify-ignore, session-start) are preserved as assets and not wired into any lifecycle.
- OpenCode/GUI slash-UX (native UI command palette) was not exercised here because the entire verification path went through the actual Commands service and real sessions; the palette presentation itself could not be observed (the session tab cannot be inspected by the toolkit).
- No Lighthouse/PSI capture: fixture is non-UI; `/webperf` measurement paths were out of scope.
- The GUI slash-command palette presentation could not be observed directly (the toolkit cannot inspect the user's DSH session tab); command delivery was verified through the actual Commands/AgentLoop services in both deterministic and live runs.
- Live capture proceeded under a temporary verifier bundle that drove three disposable sessions through the real configured provider; the verifier was removed and did not touch preset code, but the synthetic `/ship` prompt worded its instructions more prescriptively than a real user's request would ("all three concurrently", "explicit GO/NO-GO"); a live human conversation exercising open-ended routing is advisable as further acceptance.
