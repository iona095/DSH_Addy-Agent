# Addy Agent 1.0.3 — latest version files for DSH mode "Addy Agent"

Source: M:\AIFUN\WorkDir\addy-agent
Copied: 2026-10-11 (Europe/Athens)
Version: 1.0.3 (@local/dsh-addy-agent)
Upstream: https://github.com/addyosmani/agent-skills @ 1be8e34187e34647bb83adc3a1323b26ae6f6abe
Target DSH runtime: 0.2.1-alpha.2

This folder contains the repo files needed to install/run the "Addy Agent" preset in DSH (native PTC preset).
229 files total: 16 top-level + locale/en.json + 212 upstream files (upstream/.git excluded).

## Top-level (16)
- package.json (preset metadata, files list, version 1.0.3)
- index.mjs -> re-exports adapter-v2.mjs (public entry)
- adapter-v2.mjs / core-v2.mjs = active runtime
- adapter-v1.mjs / core.mjs = legacy entry kept for compatibility
- duplicate-guard.mjs / duplicate-guard-core.mjs = SEARCH-FIRST/REUSE-FIRST guard
- cordis.patch.yml = inserts only preset-addy-agent (order 10, PTC mode, 3-child specialists)
- upstream-manifest.json = 212-file Git-blob + SHA-256 manifest
- icon.svg + locale/en.json = preset presentation assets
- prepare.mjs = reproducible manifest/patch generator (never writes profile/upstream)
- README.md / VERIFICATION.md / REPAIR_NOTES.md / DUPLICATE-GUARD.md = docs

## upstream/ (212 files, .git excluded)
Pinned original Addy bytes: 9 commands (.claude/commands/*.md), 25 skills (skills/*), 4 personas (agents/*.md), references/, scripts/, hooks/, docs/, evals/, plus .agents/.claude-plugin/.codex-plugin/.gemini/commands/commands plural variants.
Verify with upstream-manifest.json SHA-256 digests. To re-clone exact bytes: git clone https://github.com/addyosmani/agent-skills + git checkout 1be8e34187e34647bb83adc3a1323b26ae6f6abe.

## locale/
- en.json (preset strings)

## Excluded (kept in source repo, not needed at runtime)
- tests/ (contract + live-verifier suites)
- evidence/ (verification JSON + live reports)
- upstream/.git (use revision above to re-fetch)
- .addy-agent-*-backup/staging, addy-agent.zip (build artifacts)

## Use in DSH
1. New session -> select "Addy Agent", working directory = target repo.
2. Do not change profile default; old sessions keep old revisions.
3. /spec /plan /build /test /constraints /review /webperf /code-simplify /ship share loadCommand (core-v2.mjs); natural-language routing uses using-agent-skills guidance, never a new router persona.
4. /ship fans out via addy_specialists (3 concurrent native children); /webperf uses 1 (web-performance-auditor).
