/**
 * addy-duplicate-guard — preset-scoped Cordis plugin.
 *
 * Enforces SEARCH-FIRST / REUSE-FIRST on production source mutations for the
 * `addy-agent` DSH preset only. It is a separate plugin from the Addy adapter
 * (`@local/dsh-addy-agent`): it registers no service, changes no model routing,
 * no PTC presentation, no specialist execution and no result summarization.
 *
 * Enforcement layers
 *   1. `tools/pre-execute` (prepended, async) — the policy gate whose denial
 *      text tells the model exactly which preflight is missing. Scope-filtered
 *      dispatch delivers nested PTC sub-calls here too.
 *   2. `ctx.tools.guard` (monotonic, synchronous) — the same decision as a
 *      backstop no later listener can turn back into permission.
 *   3. `tools/post-execute` — the automatic post-edit recheck of every newly
 *      introduced function.
 *   4. Git-boundary validation on `git commit`/`git push` — detects functions
 *      that reached the worktree through a path layer 1–3 did not see.
 *
 * Coverage and residual bypasses are stated in DUPLICATE-GUARD.md; nothing here
 * claims enforcement over a path this module cannot observe.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeFsMutation, analyzeRunCode, analyzeShellCommand, classifyPath,
  gitBoundaryIntroduced, gitFileAt, gitHead, introducedSymbols, normalizeScopeEntry,
  pathInScope, persistEvidenceRecord, refMutatingGit, repositoryRoot, scanRepository, toRepoRelative,
} from './duplicate-guard-core.mjs';

export const name = 'addy-duplicate-guard';
export const inject = ['tools', 'systemPrompt'];
/** Corrective-repair generation marker, surfaced in `status` and the activation log. */
export const generation = 'r1';

const ROOT = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = join(ROOT, 'evidence', 'duplicate-guard');
const HEAD_TTL_MS = 1500;
const textBlock = (text) => ({ type: 'text', text });

const DEFAULT_POLICY = {
  enabled: true,
  productionPaths: [],
  exemptPaths: [],
  scan: { maxFiles: 4000, maxBytes: 24 * 1024 * 1024, maxFileBytes: 512 * 1024, maxRefsPerName: 25 },
  postcheckScan: { maxFiles: 2500, maxBytes: 12 * 1024 * 1024, maxFileBytes: 512 * 1024, maxRefsPerName: 5 },
};

const PROMPT = [
  '# Duplicate guard (enforced, preset-scoped)',
  'SEARCH-FIRST / REUSE-FIRST is enforced on production source mutations. Test files, docs, config and read-only inspection are never gated.',
  'Before implementing a NEW production function, call `addy_duplicate_guard` with action "preflight" and: the task/intent, the edit scope you will touch (repo-relative paths), the exact symbol names you intend to introduce, your decision (reuse|extend|compose|new), and a candidate entry with justification for every existing declaration the scan reports.',
  'The tool runs the repository scan itself and returns the evidence it found; your assertions are not the evidence. An exact existing declaration makes decision "new" fail unless you acknowledge that exact collision with explicit reasoning. A similar name is reported but never auto-rejects. A clean scan permits new functionality. A preflight is accepted only after its decision record has been durably written and verified; if persistence fails, nothing is authorised and the failure names the cause — fix the storage problem and retry.',
  'One accepted preflight authorises every production edit inside the recorded scope at the recorded repository revision, so a task needs one preflight, not one per edit. It is invalidated when the path falls outside the scope or HEAD moves (for example after a commit): run the preflight again for that revision.',
  'After editing, newly introduced functions are rechecked automatically; `addy_duplicate_guard` action "status" reports the outcome and any blocker, and "acknowledge" resolves a same-name collision you decided to keep. A FAILED post-edit verification is itself an explicit blocker — never a silent pass. `git commit`/`git push` are validated against the same approval and are denied while any recheck blocker is unresolved; clear it with action "recheck" (once the cause is fixed) or "acknowledge".',
  'If a denial names a missing or stale discovery record, run the preflight — do not re-issue the mutation unchanged.',
].join('\n');

/** Install the duplicate guard into the calling preset scope. */
export function apply(ctx, config = {}) {
  const policy = mergePolicy(config);
  if (policy.enabled === false) return;

  /** Where accepted decision records are persisted; overridable for deployment and regression tests. */
  const evidenceDir = config?.evidenceDir ? resolve(String(config.evidenceDir)) : EVIDENCE_DIR;
  /**
   * Test-only fault seam (`config.__testForceRecheckError`): when it is a
   * function, it is invoked with the pending entry before each automatic
   * post-edit recheck, and an Error it returns is thrown in place of the
   * recheck to exercise the fail-closed path. Inert unless explicitly
   * configured; no shipped composition row sets it.
   */
  const recheckFault = typeof config?.__testForceRecheckError === 'function' ? config.__testForceRecheckError : undefined;

  /** agentId -> approval records, newest last. */
  const approvals = new Map();
  /** agentId -> post-edit recheck records, newest last. */
  const rechecks = new Map();
  /** execution token -> the mutation an approved call is about to perform. */
  const pending = new Map();
  /** execution token -> memoized decision (pre-execute and the monotonic guard share one evaluation). */
  const decided = new Map();
  /** execution token -> repository whose cached HEAD must be re-read after a ref-moving git command. */
  const refInvalidations = new Map();
  const rootCache = new Map();
  const headCache = new Map();
  const metrics = { evaluations: 0, denied: 0, allowed: 0, failures: 0, totalMs: 0, maxMs: 0, preflights: 0, preflightMs: 0, rechecks: 0, recheckMs: 0, recheckFailures: 0, byKind: {} };

  /* ------------------------------------------------------------ environment */

  const agentCwd = (agent) => agent?.session?.header?.cwd ?? process.cwd();

  function repoOf(agent) {
    const cwd = agentCwd(agent);
    let root = rootCache.get(cwd);
    if (root === undefined) {
      root = repositoryRoot(cwd);
      rootCache.set(cwd, root);
    }
    return root;
  }

  function headOf(root) {
    const cached = headCache.get(root);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < HEAD_TTL_MS) return cached.value;
    const value = gitHead(root);
    headCache.set(root, { value, at: now });
    return value;
  }

  function readAt(root, rel) {
    try { return { exists: true, content: readFileSync(join(root, rel), 'utf8') }; } catch { return { exists: false, content: '' }; }
  }

  /* -------------------------------------------------------------- approvals */

  const listFor = (map, agentId) => {
    let list = map.get(agentId);
    if (list === undefined) { list = []; map.set(agentId, list); }
    return list;
  };

  function findApproval(agentId, rel, head) {
    for (const record of [...(approvals.get(agentId) ?? [])].reverse()) {
      if (record.revision === head && pathInScope(rel, record.scope)) return record;
    }
    return null;
  }

  const anyApproval = (agentId, head) => (approvals.get(agentId) ?? []).some((r) => r.revision === head);

  /**
   * Symbols every accepted record at this revision covers. Raw PTC writes and
   * shell writes never reach `tools/post-execute` as an fs mutation, so their
   * introduced declarations must be declared up front instead of rechecked
   * afterwards.
   */
  function approvedSymbols(agentId, head) {
    const out = new Set();
    for (const record of approvals.get(agentId) ?? []) {
      if (record.revision !== head) continue;
      for (const name of record.symbols) out.add(name);
    }
    return out;
  }
  function undeclaredIntroductions(agentId, head, names) {
    const approved = approvedSymbols(agentId, head);
    return [...new Set(names)].filter((name) => !approved.has(name));
  }

  function blockersFor(agentId) {
    return (rechecks.get(agentId) ?? []).filter((r) => r.unacknowledged.length > 0 && r.resolvedBy === null);
  }

  /* ------------------------------------------------------------- decisions */

  function evaluated(exec) {
    const memo = decided.get(exec.token);
    if (memo !== undefined) return memo;
    const startedAt = performance.now();
    let outcome;
    try {
      outcome = decide(exec);
    } catch (error) {
      metrics.failures += 1;
      outcome = {
        action: 'deny',
        kind: 'internal-failure',
        reason: `ADDY-DUPLICATE-GUARD internal failure while evaluating "${exec.name}"; the call was blocked rather than risk an unreviewed production mutation. Report this message. Cause: ${error?.message ?? String(error)}`,
      };
    }
    const elapsed = performance.now() - startedAt;
    metrics.evaluations += 1;
    metrics.totalMs += elapsed;
    if (elapsed > metrics.maxMs) metrics.maxMs = elapsed;
    if (outcome.action === 'deny') metrics.denied += 1; else metrics.allowed += 1;
    const bucket = (metrics.byKind[outcome.kind ?? 'unknown'] ??= { count: 0, totalMs: 0, maxMs: 0 });
    bucket.count += 1;
    bucket.totalMs = Number((bucket.totalMs + elapsed).toFixed(3));
    if (elapsed > bucket.maxMs) bucket.maxMs = Number(elapsed.toFixed(3));
    if (decided.size > 4096) decided.clear();
    decided.set(exec.token, outcome);
    return outcome;
  }

  const allow = (kind) => ({ action: 'allow', kind });
  const deny = (kind, reason) => ({ action: 'deny', kind, reason });

  function decide(exec) {
    if (exec.agent === undefined) return allow('no-agent');
    switch (exec.name) {
      case 'write':
      case 'edit': return decideFs(exec);
      case 'pwsh':
      case 'bash': return decideShell(exec);
      case 'run_code': return decideRunCode(exec);
      default: return allow('untracked-tool');
    }
  }

  function decideFs(exec) {
    const args = exec.arguments ?? {};
    const rawPath = args.file_path ?? args.path;
    if (typeof rawPath !== 'string' || rawPath.length === 0) return allow('fs-no-path');
    const root = repoOf(exec.agent);
    const rel = toRepoRelative(root, rawPath);
    if (rel === null) return allow('fs-outside-repository');
    if (!classifyPath(rel, policy).production) return allow('fs-ungated-path');
    // `rel` is the single normalized repository representation of the target:
    // the analysis, every read and every report use it, so an absolute and a
    // relative path for the same file produce the identical decision.
    const mutation = analyzeFsMutation({ toolName: exec.name, args, rel }, (p) => readAt(root, p), policy);
    if (mutation.introduced.length === 0) return allow('fs-no-new-function');
    const head = headOf(root);
    const approval = findApproval(exec.agent.id, rel, head);
    if (approval === null) return deny('fs-mutation-unapproved', missingEvidence(exec, rel, mutation.introduced, root, head));
    pending.set(exec.token, { agentId: exec.agent.id, root, head, rel, introduced: mutation.introduced, approval });
    return allow('fs-mutation-approved');
  }

  function decideShell(exec) {
    const command = exec.arguments?.command;
    if (typeof command !== 'string' || command.length === 0) return allow('shell-no-command');
    const analysis = analyzeShellCommand(command, policy);
    const root = (analysis.gated || analysis.gitCommit || analysis.gitPush) ? repoOf(exec.agent) : null;
    if (analysis.gitCommit || analysis.gitPush) {
      if (refMutatingGit(command)) refInvalidations.set(exec.token, root);
      const head = headOf(root);
      const blocked = boundaryBlockers(exec.agent, root, head);
      if (blocked.length > 0) {
        return deny('git-boundary-denied', `ADDY-DUPLICATE-GUARD refused this git ${analysis.gitPush ? 'push' : 'commit'}: the repository boundary still holds unreviewed production function introductions.\n${blocked.join('\n')}\nResolve each item (re-run addy_duplicate_guard {action:"recheck"} once the cause is cleared, remove the duplicate, or record your reasoning with {action:"acknowledge", ...}) before committing. Committing a revision that fails this check would also invalidate the current discovery evidence.`);
      }
      return allow('git-boundary-approved');
    }
    if (refMutatingGit(command)) refInvalidations.set(exec.token, root);
    if (!analysis.gated) return allow('shell-ungated');
    const head = headOf(root);
    const undeclared = undeclaredIntroductions(exec.agent.id, head, analysis.declaredNames);
    if (analysis.paths.length === 0) {
      if (anyApproval(exec.agent.id, head) && undeclared.length === 0) return allow('shell-mutation-approved');
      return deny('shell-mutation-unapproved', shellDenial(command, [], analysis, head, undeclared, 'the command creates or declares a function but names no inspectable source path'));
    }
    const missing = analysis.paths.filter((p) => findApproval(exec.agent.id, p, head) === null);
    if (missing.length === 0 && undeclared.length === 0) return allow('shell-mutation-approved');
    return deny('shell-mutation-unapproved', shellDenial(command, missing, analysis, head, undeclared, 'no accepted discovery record covers every production path and declaration this command writes'));
  }

  function decideRunCode(exec) {
    // Only the root program carries code; nested sub-calls are dispatched
    // under their own tool names and are gated by the write/edit/shell paths.
    if (exec.parent !== undefined) return allow('ptc-nested-dispatch');
    const code = exec.arguments?.code;
    if (typeof code !== 'string' || code.length === 0) return allow('run-code-no-source');
    const analysis = analyzeRunCode(code, policy);
    if (!analysis.gated) return allow('run-code-ungated');
    const root = repoOf(exec.agent);
    const head = headOf(root);
    const missing = analysis.paths.filter((p) => findApproval(exec.agent.id, p, head) === null);
    const undeclared = undeclaredIntroductions(exec.agent.id, head, analysis.declaredNames);
    if (missing.length === 0 && undeclared.length === 0) return allow('run-code-direct-write-approved');
    const primitives = [...analysis.writePrimitives, ...analysis.processPrimitives];
    return deny('run-code-direct-write-denied', [
      'ADDY-DUPLICATE-GUARD blocked this run_code program before execution.',
      `It performs a direct filesystem/process mutation (${primitives.join(', ')}) outside the guarded tools.write / tools.edit path.`,
      missing.length > 0 ? `Production source it writes without an accepted record: ${missing.join(', ')}.` : null,
      undeclared.length > 0 ? `Function declarations it writes that no accepted record declares: ${undeclared.join(', ')}. A direct write has no post-edit recheck, so its declarations must be covered by the preflight in advance.` : null,
      'Two accepted ways forward:',
      '  1. Use the bound tools.write / tools.edit calls instead — they carry the same policy and their new functions are rechecked after editing.',
      `  2. Record discovery evidence that names those symbols and paths first: addy_duplicate_guard {action:"preflight", ...}${undeclared.length > 0 ? ` with symbols ${JSON.stringify(undeclared.map((name) => ({ name })))}` : ''}.`,
      `Repository revision: ${head ?? '(not a git repository)'}.`,
    ].filter(Boolean).join('\n'));
  }

  function boundaryBlockers(agent, root, head) {
    const lines = [];
    for (const recheck of blockersFor(agent.id)) {
      if (recheck.status === 'verification-failed') {
        lines.push(`- post-edit recheck of ${recheck.file} FAILED (${recheck.verificationError?.name ?? 'Error'}: ${recheck.verificationError?.message ?? 'unknown'}); the edit introducing ${recheck.introduced.join(', ')} is unverified`);
      } else {
        lines.push(`- post-edit recheck at ${recheck.file} found unreviewed same-name declaration(s): ${recheck.unacknowledged.map((d) => `${d.name} also declared at ${d.path}:${d.line}`).join('; ')}`);
      }
    }
    const boundary = gitBoundaryIntroduced({ root, head, config: policy, isPathApproved: (rel) => findApproval(agent.id, rel, head) !== null });
    for (const item of boundary.outsideScope) {
      lines.push(`- ${item.path}:${item.line} declares ${item.name}(), newly introduced relative to HEAD and outside every accepted edit scope`);
    }
    return lines;
  }

  function missingEvidence(exec, rel, introduced, root, head) {
    const records = approvals.get(exec.agent.id) ?? [];
    const stale = records.filter((r) => r.revision !== head);
    const names = introduced.map((s) => `${s.name} (${rel}:${s.line})`).join(', ');
    const lines = [
      `ADDY-DUPLICATE-GUARD blocked ${exec.name} → ${rel}: it introduces new production function(s): ${names}.`,
      records.length === 0
        ? 'No discovery evidence exists for this task yet.'
        : stale.length > 0
          ? `Recorded evidence is stale: recorded at revision ${stale[stale.length - 1].revision ?? '(none)'}, repository HEAD is ${head ?? '(none)'}.`
          : `Recorded evidence exists but does not cover ${rel}: accepted scope ${JSON.stringify(records[records.length - 1].scope)}.`,
      'Required before implementing: call addy_duplicate_guard with action "preflight", a task label, the intent, the edit scope containing this path, the exact symbol names being introduced, and your decision (reuse|extend|compose|new). The tool performs the repository search and records the decision at the current revision.',
      `Repository revision for that record: ${head ?? '(not a git repository)'}.`,
    ];
    return lines.join('\n');
  }

  function shellDenial(command, missing, analysis, head, undeclared, why) {
    return [
      `ADDY-DUPLICATE-GUARD blocked a shell mutation because ${why}.`,
      `Command: ${command.length > 240 ? `${command.slice(0, 240)}…` : command}`,
      `Detected write constructs: ${analysis.writes.join(', ') || '(none)'}${analysis.opaque.length > 0 ? `; inline program: ${analysis.opaque.join(', ')}` : ''}.`,
      missing.length > 0 ? `Uncovered production paths: ${missing.join(', ')}.` : 'No production path could be extracted from the command text, so the implicit scope must already be approved.',
      undeclared.length > 0 ? `Function declarations not covered by any accepted record: ${undeclared.join(', ')}. A shell write has no post-edit recheck, so its declarations must be declared in the preflight.` : null,
      `Required: addy_duplicate_guard {action:"preflight", scope:[...], symbols:[...], ...} at revision ${head ?? '(none)'}. Read-only commands, test runs and plans are not gated.`,
    ].filter(Boolean).join('\n');
  }

  /* --------------------------------------------------------------- recheck */

  function runRecheck(agentId, entry) {
    const startedAt = performance.now();
    const declared = new Set(entry.approval.symbols);
    const introduced = entry.introduced.map((s) => s.name);
    const undeclared = introduced.filter((n) => !declared.has(n));
    let declarations = {};
    if (undeclared.length > 0) {
      const scan = scanRepository({ root: entry.root, names: undeclared, config: { ...policy, scan: policy.postcheckScan } });
      declarations = scan.declarations;
    }
    for (const name of introduced) {
      if (declarations[name] === undefined) {
        declarations[name] = dedupeCollisions((entry.approval.collisions ?? []).filter((c) => c.name === name));
      }
    }
    const unacknowledged = [];
    for (const name of introduced) {
      for (const hit of declarations[name] ?? []) {
        if (hit.path === entry.rel) continue;
        if ((entry.approval.collisions ?? []).some((c) => c.name === name && c.path === hit.path)) continue;
        unacknowledged.push({ name, path: hit.path, line: hit.line });
      }
    }
    const record = {
      file: entry.rel, revision: entry.head, at: new Date().toISOString(),
      status: 'verified',
      introduced, undeclaredSymbols: undeclared,
      unacknowledged: dedupeCollisions(unacknowledged), resolvedBy: null, durationMs: Math.round(performance.now() - startedAt),
    };
    const list = listFor(rechecks, agentId);
    const index = list.findIndex((r) => r.file === record.file && r.revision === record.revision);
    if (index === -1) list.push(record); else list[index] = record;
    metrics.rechecks += 1;
    metrics.recheckMs += record.durationMs;
    return record;
  }

  /**
   * Fail-closed post-edit verification: an unexpected recheck failure becomes
   * an EXPLICIT unresolved blocker — never a silent pass. The blocker names
   * the affected file and the introduced declarations of the edit, retains the
   * underlying error, is visible through `status`, and denies `git commit` /
   * `git push` until a later recheck of the same file and revision succeeds
   * (replacing this record) or the acknowledge procedure resolves it.
   */
  function recordRecheckFailure(agentId, entry, error) {
    const record = {
      file: entry.rel, revision: entry.head, at: new Date().toISOString(),
      status: 'verification-failed',
      introduced: entry.introduced.map((s) => s.name),
      undeclaredSymbols: [],
      unacknowledged: entry.introduced.map((s) => ({ name: s.name, path: entry.rel, line: s.line ?? null })),
      verificationError: { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null },
      resolvedBy: null, durationMs: 0,
    };
    const list = listFor(rechecks, agentId);
    const index = list.findIndex((r) => r.file === record.file && r.revision === record.revision);
    if (index === -1) list.push(record); else list[index] = record;
    metrics.recheckFailures += 1;
    return record;
  }

  const dedupeCollisions = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = `${item.name}@${item.path}:${item.line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  };

  /* ---------------------------------------------------------------- tools */

  const parameters = (properties, required) => ({ type: 'object', properties, additionalProperties: false, ...(required ? { required } : {}) });
  const output = { schema: { type: 'object' }, render: (_args, value) => [textBlock(JSON.stringify(value, null, 2))] };

  function preflight(exec, args) {
    const startedAt = performance.now();
    const root = repoOf(exec.agent);
    const head = headOf(root);
    const scope = [...new Set((args.scope ?? []).map(normalizeScopeEntry).filter(Boolean))];
    if (scope.length === 0) throw new Error('preflight requires a non-empty repo-relative "scope" (the paths this implementation task may edit)');
    if (typeof args.task !== 'string' || args.task.trim() === '') throw new Error('preflight requires a "task" label identifying the implementation task');
    const decision = args.decision ?? 'new';
    if (!['reuse', 'extend', 'compose', 'new'].includes(decision)) throw new Error('decision must be one of reuse, extend, compose, new');
    const symbols = (args.symbols ?? []).filter((s) => s && typeof s.name === 'string' && s.name.length > 0);
    if (symbols.length === 0) throw new Error('preflight requires at least one entry in "symbols" ({name, file}) describing the functions this task introduces');
    const names = [...new Set(symbols.map((s) => s.name))];
    // The scan runs BEFORE the decision is accepted; the record is what the
    // policy trusts, not the caller's assertion that a search happened.
    const scan = scanRepository({ root, names, config: policy });
    const candidates = (args.candidates ?? []).filter((c) => c && typeof c.path === 'string');
    const acknowledged = (args.acknowledged ?? []).filter((a) => a && typeof a.name === 'string');

    const collisions = [];
    const unresolved = [];
    for (const symbol of symbols) {
      const intended = typeof symbol.file === 'string' ? toRepoRelative(root, symbol.file) : null;
      for (const hit of scan.declarations[symbol.name] ?? []) {
        if (intended !== null && hit.path === intended) continue;
        const match = acknowledged.find((a) => a.name === symbol.name && (a.path === undefined || toRepoRelative(root, a.path) === hit.path));
        const record = { name: symbol.name, path: hit.path, line: hit.line, kind: hit.kind, justification: match?.justification ?? null };
        collisions.push(record);
        if (match === undefined) unresolved.push(record);
      }
    }
    if (decision === 'new' && unresolved.length > 0) {
      const detail = unresolved.map((c) => `  - ${c.name} is already declared at ${c.path}:${c.line} (${c.kind})`).join('\n');
      throw new Error([
        `preflight rejected: decision "new" is not justified while equivalent declarations exist.`,
        detail,
        'Options: reuse or extend the existing declaration (record it in "candidates" and set decision accordingly), or keep a new one and acknowledge each exact collision in "acknowledged" with explicit reasoning. A similar-but-different name is never auto-rejected.',
      ].join('\n'));
    }
    if (decision !== 'new' && candidates.length === 0) {
      throw new Error(`preflight rejected: decision "${decision}" requires at least one "candidates" entry naming the existing declaration you will reuse, extend or compose.`);
    }

    const record = {
      recordId: `dg_${randomUUID()}`,
      task: args.task, intent: typeof args.intent === 'string' ? args.intent : null,
      agentId: exec.agent.id, revision: head, root, scope, decision,
      justification: typeof args.justification === 'string' ? args.justification : null,
      symbols: names,
      symbolFiles: Object.fromEntries(symbols.map((s) => [s.name, typeof s.file === 'string' ? toRepoRelative(root, s.file) : null])),
      candidates, collisions, acknowledged,
      scan: {
        filesScanned: scan.filesScanned, bytesScanned: scan.bytesScanned, truncated: scan.truncated, truncatedReason: scan.truncatedReason,
        durationMs: scan.durationMs, declarations: scan.declarations, similar: scan.similar,
        references: Object.fromEntries(Object.entries(scan.references).map(([k, v]) => [k, v.slice(0, 8)])),
      },
      at: new Date().toISOString(),
    };
    // Fail-closed persistence: an accepted decision must have a durable,
    // verified evidence record BEFORE it can authorize anything. If the
    // record cannot be written and read-back-verified, no approval is
    // registered in memory, protected mutations stay gated, and the caller
    // receives the original cause plus a safe retry path (every attempt
    // writes a fresh hash-addressed file, so retries never collide).
    let evidence;
    try {
      evidence = persistEvidenceRecord({ dir: evidenceDir, record });
    } catch (error) {
      throw new Error(`preflight rejected: discovery evidence could not be persisted and verified, so NO approval was registered and production mutations remain gated. Resolve the storage problem and retry (a retry is safe: each attempt writes a fresh hash-addressed record). Cause: ${error?.message ?? String(error)}`);
    }
    listFor(approvals, exec.agent.id).push(record);
    metrics.preflights += 1;
    metrics.preflightMs += Math.round(performance.now() - startedAt);
    return {
      accepted: true, recordId: record.recordId, task: record.task, decision,
      revision: head, scope,
      symbols: names,
      declaredElsewhere: collisions,
      unresolvedCollisions: unresolved.length,
      acknowledgedCollisions: collisions.length - unresolved.length,
      search: {
        filesScanned: scan.filesScanned, bytesScanned: scan.bytesScanned,
        truncated: scan.truncated, truncatedReason: scan.truncatedReason, durationMs: scan.durationMs,
        declarations: Object.fromEntries(Object.entries(scan.declarations).map(([k, v]) => [k, v.slice(0, 12)])),
        similarNames: Object.fromEntries(Object.entries(scan.similar).map(([k, v]) => [k, v.slice(0, 8)])),
        referenceSample: Object.fromEntries(Object.entries(scan.references).map(([k, v]) => [k, v.slice(0, 5)])),
      },
      note: `This record authorises production edits inside ${JSON.stringify(scope)} at revision ${head ?? '(none)'} only. It expires when HEAD moves or a path falls outside the scope.`,
      evidence,
    };
  }

  try {
    ctx.effect(() => ctx.systemPrompt.section({ name: 'addy-duplicate-guard', order: 160, interpolate: false, text: PROMPT }));
  } catch (error) {
    ctx.logger?.warn?.(`addy-duplicate-guard: prompt section not registered (${error.message})`);
  }

  ctx.effect(() => ctx.tools.register({
    name: 'addy_duplicate_guard',
    description: 'Mandatory SEARCH-FIRST / REUSE-FIRST preflight for introducing production functions. Performs the repository search itself and records a revision-bound decision record that authorises production edits inside the declared scope. Actions: preflight (required before implementing a new function), recheck (re-run the post-edit recheck for a file), status (records, rechecks, blockers, overhead), acknowledge (resolve a same-name collision you decided to keep).',
    parameters: parameters({
      action: { type: 'string', enum: ['preflight', 'recheck', 'status', 'acknowledge'] },
      task: { type: 'string' },
      intent: { type: 'string' },
      scope: { type: 'array', items: { type: 'string' } },
      decision: { type: 'string', enum: ['reuse', 'extend', 'compose', 'new'] },
      justification: { type: 'string' },
      symbols: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string' } }, required: ['name'], additionalProperties: false } },
      candidates: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, kind: { type: 'string' }, decision: { type: 'string' }, justification: { type: 'string' } }, required: ['path'], additionalProperties: false } },
      acknowledged: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, justification: { type: 'string' } }, required: ['name', 'justification'], additionalProperties: false } },
      file: { type: 'string' },
    }, ['action']),
    output,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('addy_duplicate_guard requires a calling Agent');
      const action = args.action;
      if (action === 'preflight') return preflight(exec, args);
      if (action === 'recheck') {
        const root = repoOf(exec.agent);
        const head = headOf(root);
        const rel = typeof args.file === 'string' ? toRepoRelative(root, args.file) : null;
        const records = [];
        for (const approval of approvals.get(exec.agent.id) ?? []) {
          if (approval.revision !== head) continue;
          const files = rel === null ? [...new Set(Object.values(approval.symbolFiles).filter((f) => typeof f === 'string'))] : [rel];
          for (const file of files) {
            const current = readAt(root, file);
            if (!current.exists) continue;
            const before = head === null ? '' : (gitFileAt(root, head, file) ?? '');
            const introduced = introducedSymbols(before, current.content, file);
            if (introduced.length === 0) continue;
            records.push(runRecheck(exec.agent.id, { root, head, rel: file, introduced, approval }));
          }
        }
        return { action, revision: head, rechecks: records, blockers: blockersFor(exec.agent.id) };
      }
      if (action === 'acknowledge') {
        if (typeof args.file !== 'string') throw new Error('acknowledge requires "file" (the file whose recheck blocker you are resolving)');
        if (typeof args.justification !== 'string' || args.justification.trim() === '') throw new Error('acknowledge requires "justification": your explicit reasoning for keeping this same-name declaration');
        const root = repoOf(exec.agent);
        const rel = toRepoRelative(root, args.file);
        const targets = blockersFor(exec.agent.id).filter((recheck) => rel === null || recheck.file === rel);
        if (targets.length === 0) throw new Error(`no unresolved recheck blocker for ${rel ?? args.file}; nothing to acknowledge`);
        const resolution = {
          kind: 'acknowledge', agentId: exec.agent.id, file: rel, justification: args.justification,
          resolved: targets.map((recheck) => ({ file: recheck.file, status: recheck.status ?? 'verified', unacknowledged: recheck.unacknowledged, verificationError: recheck.verificationError ?? null })),
          at: new Date().toISOString(),
        };
        // Fail-closed like the preflight: the resolution takes effect only
        // after its evidence is durably persisted and verified; on failure
        // the blocker(s) stay unresolved and commits stay denied.
        let evidence;
        try {
          evidence = persistEvidenceRecord({ dir: evidenceDir, record: resolution });
        } catch (error) {
          throw new Error(`acknowledge rejected: resolution evidence could not be persisted and verified, so the blocker(s) remain unresolved and git commit/push stay denied. Resolve the storage problem and retry. Cause: ${error?.message ?? String(error)}`);
        }
        const resolvedAt = new Date().toISOString();
        for (const recheck of targets) recheck.resolvedBy = { justification: args.justification, at: resolvedAt };
        return { action, resolved: resolution.resolved, blockers: blockersFor(exec.agent.id), evidence };
      }
      const root = repoOf(exec.agent);
      const head = headOf(root);
      const records = (approvals.get(exec.agent.id) ?? []).map((r) => ({
        recordId: r.recordId, task: r.task, decision: r.decision, revision: r.revision,
        stale: r.revision !== head, scope: r.scope, symbols: r.symbols,
        declaredElsewhere: r.collisions.length, at: r.at,
      }));
      return {
        action: 'status', generation, revision: head, root,
        records, activeRecords: records.filter((r) => !r.stale).length,
        rechecks: rechecks.get(exec.agent.id) ?? [],
        blockers: blockersFor(exec.agent.id),
        policy: { productionExtensions: [...new Set(policy.productionPaths)].length > 0 ? `restricted to ${policy.productionPaths.join(', ')}` : 'all production source extensions', exemptPaths: policy.exemptPaths },
        overhead: { ...metrics, averageEvaluationMs: metrics.evaluations === 0 ? 0 : Number((metrics.totalMs / metrics.evaluations).toFixed(3)) },      };
    },
  }));

  /* ------------------------------------------------- enforcement layers 1-3 */

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = evaluated(exec);
    if (decision.action === 'deny') return { kind: 'deny', reason: decision.reason, info: { name: 'DuplicateGuardDenied', code: 'ADDY_DUPLICATE_GUARD' } };
    return next();
  }, { prepend: true }));

  ctx.effect(() => ctx.tools.guard((exec) => {
    const decision = evaluated(exec);
    return decision.action === 'deny' ? decision.reason : undefined;
  }));

  ctx.effect(() => ctx.on('tools/post-execute', async (exec, result, next) => {
    decided.delete(exec.token);
    const invalidate = refInvalidations.get(exec.token);
    if (invalidate !== undefined) {
      refInvalidations.delete(exec.token);
      // A successful ref-moving git command invalidates revision-bound evidence
      // immediately, not after the debounce window.
      if (result.isError !== true) headCache.delete(invalidate);
    }
    const entry = pending.get(exec.token);
    if (entry !== undefined) {
      pending.delete(exec.token);
      if (result.isError !== true && (exec.name === 'write' || exec.name === 'edit')) {
        try {
          const injected = recheckFault?.(entry);
          if (injected !== undefined) throw injected;
          runRecheck(entry.agentId, entry);
        } catch (error) {
          // Fail-closed: an unexpected verification exception is NEVER a
          // successful verification — it becomes an explicit unresolved
          // blocker that denies git commit/push until rechecked or resolved.
          recordRecheckFailure(entry.agentId, entry, error);
        }
      }
    }
    return next();
  }));

  ctx.logger?.info?.(`addy-duplicate-guard ${generation} active (preset-scoped): production source mutations require revision-bound discovery evidence`);
}

function mergePolicy(config) {
  const scan = { ...DEFAULT_POLICY.scan, ...(config?.scan ?? {}) };
  const postcheckScan = { ...DEFAULT_POLICY.postcheckScan, ...(config?.postcheckScan ?? {}) };
  return {
    ...DEFAULT_POLICY,
    ...(config ?? {}),
    scan,
    postcheckScan,
    productionPaths: config?.productionPaths ?? DEFAULT_POLICY.productionPaths,
    exemptPaths: config?.exemptPaths ?? DEFAULT_POLICY.exemptPaths,
  };
}
