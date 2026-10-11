# Addy Agent for DSH

Independent preset `addy-agent`, bundle `@local/dsh-addy-agent@1.0.3`. Upstream [Addy Osmani Agent Skills](https://github.com/addyosmani/agent-skills) is pinned at `1be8e34187e34647bb83adc3a1323b26ae6f6abe` (upstream package 0.6.12); target DSH is `0.2.1-alpha.2`.

## Preservation boundary

All 212 tracked upstream files are byte-verified in [the manifest](upstream-manifest.json), including 25 skills, nine command definitions, four specialist personas, shared references and supporting scripts. They are kept under [upstream](upstream/) without source edits. The adapter verifies all SHA-256 digests at activation. Upstream repository-contributor AGENTS.md/CLAUDE.md are **not** mounted as general project instructions.

[The adapter module](adapter-v2.mjs) changes execution interfaces, not the upstream procedures or outputs. It does not introduce a router persona, alternate workflow, custom LLM loop, provider/model configuration, or new default. The optional original Bash hook scripts are preserved as assets, not registered as Claude hooks in DSH. The routing meta-skill is supplied through the scoped system-prompt registry; SDD-cache and simplify-ignore optional Bash hook integration is not implemented.

## Composition and use

[The Cordis patch](cordis.patch.yml) inserts only `preset-addy-agent`. The preset mounts native file/search/shell, skill, question, todo, goal and presentation tools, with `mode: ptc`; the installed shared Node PTC runtime supplies `run_code`. The scoped delegation group isolates `workflowEngine` and enables native `dsh-workflow-ptc` plus `dsh-tool-workflow` with a three-child concurrency cap. It does not change Standard, Creator, PTC, Minimal, Cordis or existing `ptc-skills` declarations.

Create a **new session**, select **Addy Agent**, and keep its working directory at the target repository. Selection is session-local; do not change the profile default. Old sessions keep their old plugin revisions.

Native UI slash commands and natural-language lifecycle requests share `loadCommand` in [core.mjs](core.mjs). Slash handlers enqueue the original definition in the durable Agent inbox. Natural-language routing uses the original `using-agent-skills` guidance in the same Agent and calls `addy_command`, not a new persona; routing ambiguity must lead to a question. The loader preserves source bytes and supplies raw arguments as a separate `$ARGUMENTS` binding. It never executes code merely because arguments look like a shell command.

| Command | Original definition | Required native binding / retained behavior |
|---|---|---|
| `/spec` | [.claude/commands/spec.md](upstream/.claude/commands/spec.md) | Load spec skill; clarify requirements, capability map approval, write spec and confirm |
| `/plan` | [.claude/commands/plan.md](upstream/.claude/commands/plan.md) | Original read-only exploration, dependency ordering, authorized planning artifacts, human review; never overwrite another unfinished plan |
| `/build` | [.claude/commands/build.md](upstream/.claude/commands/build.md) | Next task then stop |
| `/build auto`, `/build all` | [same build definition](upstream/.claude/commands/build.md) | Recognized spec, clean baseline, complete plan affirmative, planning commit, per-task RED/GREEN/regression/build/scoped commit/status; stop at failure/ambiguity/high risk; reinvoke to resume |
| `/test` | [.claude/commands/test.md](upstream/.claude/commands/test.md) | TDD or bug Prove-It; browser skill when applicable |
| `/constraints [check\|guard\|ratchet]` | [.claude/commands/constraints.md](upstream/.claude/commands/constraints.md) | Exact setup/interview/defaults/check/guard/ratchet procedures |
| `/review` | [.claude/commands/review.md](upstream/.claude/commands/review.md) | Five axes, original structured severity/fix output |
| `/webperf` | [.claude/commands/webperf.md](upstream/.claude/commands/webperf.md) | One exact web-performance persona; Quick/Deep prerequisites, full sourced report |
| `/code-simplify` | [.claude/commands/code-simplify.md](upstream/.claude/commands/code-simplify.md) | Preserve behavior, incremental changes/tests, revert failed simplification |
| `/ship` | [.claude/commands/ship.md](upstream/.claude/commands/ship.md) | Actual concurrent three specialists, main-agent phases B/C, GO/NO-GO, blockers/fixes/risks, rollback triggers/procedure/RTO and full reports |

The runtime's generic plan-mode plugin would replace conversational approval wording and prohibit the exact planning-file writes instructed upstream. It is intentionally not copied into this preset. `/plan` uses the original Addy read-only procedure and its explicit artifact exception; this is model-directed procedure, not a sandbox mode change. DSH permissions still govern all tool execution.

`agent-skills:<name>` maps to native `skill({name:'<name>'})`. All skill bodies retain original bytes and a resource base pointing at the actual installed skill directory. References remain relative to those original locations.

## Specialists and concurrency

Call `addy_specialists` once with all three `/ship` persona names and complete scope/spec/diff context. The host starts all three `subagents.startActivation` requests before awaiting results, with `delivery:'caller'`, `provider:'spawn'`, independent live child Agents, the original persona as a native scoped persona prefix, `maxDepth:1`, and denied delegation tools. Inherited delegation tools are hidden with native per-child restrictions where supported. Child-local delegation tools cannot be hidden by DSH's global restriction API, so an exact-child monotonic guard denies their execution, including nested PTC calls. The guard is installed during awaited `agent/created`, before publication and model/tool execution; it does not affect the parent or unrelated agents. Accepted native children are explicitly disposed and drained on caller cancellation, because the native activation signal only governs startup. Persona-load and cleanup failures are retained without discarding sibling reports. No sequential-roleplay fallback is permitted. For `/webperf`, use just `web-performance-auditor` and pass scope/artifacts/URL/mode as instructed upstream.

Original `/ship` persona precedence is retained: target `.claude/agents/<persona>.md`, then user `~/.claude/agents/<persona>.md`, then the pinned original. Each report records the actual source path/hash and override flag; overrides are not falsely described as original pinned persona bytes.

In **this installed DSH version**, workflow `agent(prompt,opts)` only forwards prompt/schema/provider/model. It does **not** pass persona/toolFilter/maxDepth, and ordinary failures can become `null`. The specialist adapter therefore uses the existing native subagent service directly, available through PTC tool dispatch. The native workflow engine remains available for general programmatic coordination; it is not monkeypatched or substituted with a homemade loop. `runSpecialists` retains raw stop reason, diagnostics, errors, child identity and full independent outputs before organizing results. Incomplete branches cannot establish GO. Main-agent synthesis remains the exact original command, including direct accessibility/infrastructure/documentation verification and full report sections.

## Result layer and evidence

`addy_results` records command/raw arguments, all observed completed tool outcomes since the latest invocation, attempted operations, completed/failed child counts, exact unique/duplicate result counts, attributed grouped findings by file/severity/agent, errors, verification references and a concise summary. SHA-256-addressed full JSON evidence is written under [evidence](evidence/); summaries carry its full path/hash/size and report pointers. **Compact responses contain no embedded full specialist reports**, including inside `groups.byAgent`; that group contains JSON pointers such as `/reports/0` instead. To perform the original `/ship` synthesis and include full specialist reports, load `fullResult.path` with the available file/shell tools and extract `reports[index]` using the provided pointers. Complete original reports, their status, provenance, findings and raw tool operations remain unmodified in the evidence file. Compact projection does not replace original `/ship` full-report requirements.

Only **exact semantic finding duplicates** are grouped; differing severities or assessments remain separate and every source attribution is retained. Repeated side-effect executions are never skipped. The adapter does not synthesize a verdict or invent token savings. Counts distinguish observable adapter events from child tool operations available only in their durable child session logs. Full files must be loaded before final synthesis. Tool-event memory is a cache scoped to a live Agent; persisted native session logs remain authoritative on resume. Results from before an adapter activation must be reconstructed from those logs, not assumed present in its cache.

## Duplicate guard (enforced search-first / reuse-first)

The preset also mounts [a second, separate plugin](duplicate-guard.mjs), `addy-duplicate-guard`, as the last row of `preset-addy-agent.plugins`. It enforces SEARCH-FIRST / REUSE-FIRST on production source mutations for this preset only: before introducing a new production function the agent must obtain a revision-bound discovery record from the `addy_duplicate_guard` tool, which performs the repository scan itself and records the decision, the intended edit scope and the justification. One accepted record authorises every production edit inside that scope at that revision; a path outside the scope or a moved HEAD invalidates it.

Enforcement uses the native pipeline: a prepended `tools/pre-execute` gate (which also sees nested PTC sub-dispatches), a monotonic `ctx.tools.guard` backstop, an automatic post-edit recheck of newly introduced functions, and git-boundary validation on `git commit`/`git push`. Read-only inspection, test runs, planning, test-driven development and edits that introduce no new declaration are never gated. The plugin registers no service and does not change model routing, PTC presentation, specialist concurrency or result summarization; agents outside this preset are unaffected. Both decision paths are fail-closed: a preflight is accepted only after its evidence record is written and read-back-verified (byte length and SHA-256), and an unexpected post-edit verification failure becomes an explicit blocker that denies commits until rechecked or acknowledged.

Full contract, evidence, measured overhead and the remaining bypass limitations are in [DUPLICATE-GUARD.md](DUPLICATE-GUARD.md).

## Installation and reversal

Install this workspace bundle with the native Plugin Manager `install_bundle` action targeting its absolute directory. No custom install/build scripts or dependencies are required. Inspect the returned live activation status; replacing an already imported module generation may require restart.

Disable only this bundle with `plugin_manager` action `set_bundle`, target `@local/dsh-addy-agent`, enabled false. Re-enable with true. Remove only it using `remove_bundle` with the same target. No original preset/provider/model/default restoration should be necessary because those are not edited. Keep the workspace directory while installed (local installs link it), and preserve evidence before removing files. Existing sessions can retain their started revision; use a new session after disabling/removing. Rollback trigger: activation errors, unexpected scope leakage, missing original assets or failed child-fidelity tests. Procedure: disable bundle, create a fresh session with the prior `ptc-skills` selection, verify default/model unchanged; RTO target one minute for bundle disable, subject to completing active owned tasks.

## Reproduction and verification limits

Run from this directory:

```powershell
node --test tests/core.test.mjs tests/compact-results.test.mjs
node tests/contracts-runtime.mjs
node tests/contracts-config.mjs
node tests/native-runtime.mjs
node tests/native-scoped-specialists.mjs
node tests/native-cancellation.mjs
node tests/native-ptc.mjs
node tests/duplicate-guard-unit.mjs
node tests/duplicate-guard-runtime.mjs
node tests/duplicate-guard-preservation.mjs
```

Additional native contract, installed-host and configured-provider test instructions/evidence are documented in the final [verification report](VERIFICATION.md). Runtime fixtures use **real installed Cordis, AgentLoop, subagent activation and Node PTC processes**, but a deterministic test-only model transport. They do not prove production-model behavior or end-to-end lifecycle compliance. They never replace the live configured provider.

Approval prompts are disabled in the authoring session. No runtime/policy escalation is attempted: original conversational approval gates remain explicit. Permission mode is not a substitute for an Addy plan/risk sign-off. If the human question channel is unavailable, the Agent must stop at the original gate. Tests of instruction retention are not evidence that a production model obeys every gate; complete behavioral acceptance needs real configured-provider scenario runs and project fixtures.

Browser performance capture requires supplied Lighthouse/PSI/CrUX/trace artifacts or an actual configured DevTools capability; DSH browser/REA tools alone do not provide Lighthouse. `/webperf` must label source-only observations as potential impact and cannot invent scorecard values. Secrets/network/build/install/deploy tools run with the session's permissions, not an extra adapter sandbox. Full evidence can contain project information; protect it like session logs.

The icon is original adapter artwork; upstream MIT license and author attribution are preserved in [the upstream license](upstream/LICENSE).
