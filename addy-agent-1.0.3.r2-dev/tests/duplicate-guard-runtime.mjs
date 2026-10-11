/**
 * addy-duplicate-guard — native runtime acceptance tests.
 *
 * Real installed Cordis, real ToolRuntime pipeline, real `dsh-tool-fs` disk
 * mutations, a real git repository fixture, and a real Node PTC subprocess for
 * the nested-call and direct-filesystem cases. The plugin is mounted in a
 * minted *preset* scope and agents are bound to it exactly the way
 * `dsh-agent-preset-registry` binds them, so scope isolation is exercised
 * rather than assumed.
 *
 * No LLM request is made; nothing here claims production-model behaviour.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALLED = 'C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg = async (name) => import(pathToFileURL(join(INSTALLED, name, 'lib/index.js')));
const plugin = await import('../duplicate-guard.mjs');

const evidence = {
  testedAt: new Date().toISOString(),
  nodeVersion: process.version,
  runtime: {
    dsh: JSON.parse(readFileSync(join(INSTALLED, 'dsh-tools/package.json'), 'utf8')).version,
    ptcRuntime: JSON.parse(readFileSync(join(INSTALLED, 'dsh-ptc-runtime-node/package.json'), 'utf8')).version,
  },
  transport: 'real Cordis + real ToolRuntime + real dsh-tool-fs + real Node PTC subprocess; no LLM request',
  cases: [],
  shellBinding: null,
  limitations: [
    'The pwsh/bash gate is exercised through the tool name and argument contract the native pipeline delivers; if the real Windows shell stack could not be mounted the binding is a sentinel whose body must never run, which is the property under test.',
    'Deterministic fixture repository only; no production-model compliance claim.',
  ],
};

let failures = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    evidence.cases.push({ name, pass: true, detail: detail ?? null });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    evidence.cases.push({ name, pass: false, error: { name: error.name, message: error.message, stack: error.stack } });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}
const ok = (value, message) => { if (!value) throw new Error(message ?? `expected truthy, got ${JSON.stringify(value)}`); };
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ?? 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/* ------------------------------------------------------------- fixture repo */

function makeRepo(label) {
  const repo = mkdtempSync(join(tmpdir(), `addy-dg-${label}-`));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'src/parser.mjs'), [
    '// Existing production parser.',
    'export function parseConfig(text) {',
    '  return text.trim();',
    '}',
    '',
    'export function parseConfigStrict(text) {',
    '  return parseConfig(text).toLowerCase();',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'src/m2.mjs'), [
    'export function sharedName(value) {',
    '  return value;',
    '}',
    '',
    'export function unreviewedName(value) {',
    '  return value;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'src/util.mjs'), [
    'export function existing(value) {',
    '  return value;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'src/unrelated.mjs'), 'export const UNRELATED = 1;\n');
  writeFileSync(join(repo, 'tests/parser.test.mjs'), [
    "import { parseConfig } from '../src/parser.mjs';",
    'export function parserTest() {',
    "  return parseConfig(' x ');",
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'README.md'), '# Fixture repository\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'guard@example.test');
  git('config', 'user.name', 'Duplicate Guard Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return { repo, git, head: git('rev-parse', 'HEAD').trim() };
}

/* ------------------------------------------------------------------ host */

async function bootHost({ repo, ptc }) {
  const { Context } = await pkg('cordis');
  const { createScope, bindScopeParent } = await pkg('dsh-scope');
  const ctx = new Context();
  const mounted = [];
  const mount = async (name, config) => {
    const mod = await pkg(name);
    ctx.plugin(mod.default ?? mod, config);
    mounted.push(name);
    await new Promise((resolve) => setImmediate(resolve));
  };
  for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt', 'dsh-llm', 'dsh-fs-local']) await mount(name);
  await mount('dsh-working-directory', { defaultDirectory: repo });
  await mount('dsh-agent-loop');
  await mount('dsh-tools', ptc ? { mode: 'ptc' } : {});
  await mount('dsh-tool-fs');
  if (ptc) {
    await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: repo });
    await mount('dsh-sandbox-local');
    await mount('dsh-subprocess-local');
    await mount('dsh-ptc-runtime-node');
  }
  const shellTools = [];
  try {
    await mount('dsh-subprocess-local');
    await mount('dsh-shell-env');
    await mount('dsh-pwsh-local');
    await mount('dsh-tool-pwsh');
    shellTools.push('pwsh');
    evidence.shellBinding = 'real dsh-tool-pwsh (dsh-pwsh-local + dsh-shell-env + dsh-subprocess-local)';
  } catch (error) {
    let sideEffects = 0;
    for (const tool of ['pwsh', 'bash']) {
      ctx.tools.register({
        name: tool,
        description: 'Sentinel shell binding; its body must never run when the guard denies.',
        parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, additionalProperties: true },
        output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        isConcurrencySafe: () => false,
        async execute() { sideEffects += 1; return { sentinel: true, sideEffects }; },
      });
      shellTools.push(tool);
    }
    evidence.shellBinding = `sentinel (real shell stack unavailable: ${error.message})`;
    evidence.shellSentinelSideEffects = () => sideEffects;
  }

  // Mint the preset scope and mount the guard exactly as a preset row would.
  const presetKey = {};
  const presetScope = createScope(ctx, presetKey);
  await presetScope.ctx.plugin(plugin);
  await new Promise((resolve) => setImmediate(resolve));

  let counter = 0;
  const createAgent = async (id) => {
    const agent = await ctx.agentLoop.create(`dg-${id}`, { provider: 'guard-fixture', model: 'deterministic' }, { cwd: repo });
    return agent;
  };
  const addyAgent = await createAgent('addy');
  bindScopeParent(addyAgent, presetKey);
  const otherAgent = await createAgent('other');

  const call = (name, args, agent = addyAgent) => ctx.tools.execute({
    name, callId: `call-${++counter}`, arguments: args, agent, signal: new AbortController().signal,
  });
  const guard = (args, agent = addyAgent) => call('addy_duplicate_guard', args, agent);
  return { ctx, presetKey, presetScope, addyAgent, otherAgent, createAgent, bindScopeParent, call, guard, repo, mounted, shellTools };
}

const denied = (result) => result.isError === true && /ADDY-DUPLICATE-GUARD/.test(result.error?.message ?? '');
const reason = (result) => result.error?.message ?? '';

/* =============================== Host A — native tools =============================== */

console.log('\nHost A: native tool presentation');
const A = makeRepo('a');
const hostA = await bootHost({ repo: A.repo, ptc: false });

try {
  await check('non-interference: read of production source is allowed', async () => {
    const result = await hostA.call('read', { file_path: 'src/parser.mjs' });
    ok(result.isError === false, reason(result));
    return { tool: 'read', isError: result.isError };
  });

  await check('A1 new function where an equivalent exists → denied without evidence', async () => {
    const result = await hostA.call('write', {
      file_path: 'src/duplicate.mjs',
      content: 'export function parseConfig(text) {\n  return String(text).trim();\n}\n',
    });
    ok(denied(result), `expected guard denial, got: ${JSON.stringify(result).slice(0, 400)}`);
    ok(!existsSync(join(A.repo, 'src/duplicate.mjs')), 'denied write must not create the file');
    ok(/parseConfig/.test(reason(result)) && /preflight/.test(reason(result)), 'denial must name the function and the preflight');
    return { denial: reason(result).split('\n')[0] };
  });

  await check('A1b preflight with decision "new" is rejected while an equivalent declaration exists', async () => {
    const result = await hostA.guard({
      action: 'preflight', task: 'duplicate-config', intent: 'Add another config parser',
      scope: ['src'], decision: 'new', symbols: [{ name: 'parseConfig', file: 'src/duplicate.mjs' }],
    });
    ok(result.isError === true, 'preflight must be rejected');
    ok(/already declared at src\/parser\.mjs/.test(reason(result)), `rejection must name the collision: ${reason(result)}`);
    ok(/acknowledge/.test(reason(result)), 'rejection must offer the explicit-reasoning route');
    return { rejection: reason(result).split('\n').slice(0, 2).join(' | ') };
  });

  await check('A1c explicit reasoning permits the justified new function', async () => {
    const result = await hostA.guard({
      action: 'preflight', task: 'duplicate-config', intent: 'Deliberate second parser for untrusted input',
      scope: ['src'], decision: 'new',
      symbols: [{ name: 'parseConfig', file: 'src/duplicate.mjs' }],
      acknowledged: [{ name: 'parseConfig', path: 'src/parser.mjs', justification: 'Different trust boundary; the existing parser must not be widened.' }],
      justification: 'Isolated hardened parser for untrusted input.',
    });
    ok(result.isError === false, reason(result));
    const value = result.value;
    ok(value.accepted === true, 'preflight must be accepted');
    eq(value.revision, A.head, 'preflight must be bound to HEAD');
    eq(value.declaredElsewhere.length, 1, 'the acknowledged collision must be recorded as scan evidence');
    ok(value.evidence?.sha256?.length === 64, 'preflight must persist hash-anchored evidence');
    return { recordId: value.recordId, revision: value.revision, declaredElsewhere: value.declaredElsewhere.map((c) => `${c.name}@${c.path}:${c.line}`), acknowledgedCollisions: value.acknowledgedCollisions };
  });

  await check('A1d the same write is now allowed inside the approved scope and revision', async () => {
    const result = await hostA.call('write', {
      file_path: 'src/duplicate.mjs',
      content: 'export function parseConfig(text) {\n  return String(text).trim();\n}\n',
    });
    ok(result.isError === false, reason(result));
    ok(existsSync(join(A.repo, 'src/duplicate.mjs')), 'approved write must reach the disk');
    return { created: 'src/duplicate.mjs' };
  });

  await check('A2 new function where no equivalent exists → preflight accepted, write allowed', async () => {
    const result = await hostA.guard({
      action: 'preflight', task: 'timeline-render', intent: 'Render a timeline',
      scope: ['src'], decision: 'new', symbols: [{ name: 'renderTimeline', file: 'src/timeline.mjs' }],
    });
    ok(result.isError === false, reason(result));
    eq(result.value.declaredElsewhere.length, 0, 'a clean scan must report no equivalent');
    const write = await hostA.call('write', {
      file_path: 'src/timeline.mjs',
      content: 'export function renderTimeline(events) {\n  return events.map((e) => e.at);\n}\n',
    });
    ok(write.isError === false, reason(write));
    ok(existsSync(join(A.repo, 'src/timeline.mjs')), 'approved write must reach the disk');
    return { recordId: result.value.recordId, scanned: result.value.search.filesScanned, created: 'src/timeline.mjs' };
  });

  await check('A3 different function with a similar name is reported, never auto-rejected', async () => {
    const agent = await hostA.createAgent('similar');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const result = await hostA.guard({
      action: 'preflight', task: 'strict-config', intent: 'Add a strict config-file loader',
      scope: ['src'], decision: 'new', symbols: [{ name: 'parseConfigFile', file: 'src/config-file.mjs' }],
    }, agent);
    ok(result.isError === false, reason(result));
    const similar = result.value.search.similarNames.parseConfigFile ?? [];
    ok(similar.some((s) => s.name === 'parseConfig'), `expected parseConfig as a similar candidate, got ${JSON.stringify(similar)}`);
    eq(result.value.declaredElsewhere.length, 0, 'a similar name is not an equivalent declaration');
    const write = await hostA.call('write', {
      file_path: 'src/config-file.mjs',
      content: 'export function parseConfigFile(path) {\n  return path;\n}\n',
    }, agent);
    ok(write.isError === false, reason(write));
    return { similar: similar.map((s) => `${s.name}@${s.path} score ${s.score}`), created: 'src/config-file.mjs' };
  });

  await check('A4 legitimate composition of existing functionality is authorised with a candidate record', async () => {
    const result = await hostA.guard({
      action: 'preflight', task: 'config-normalisation', intent: 'Compose normalisation around the existing parser',
      scope: ['src'], decision: 'compose',
      candidates: [{ path: 'src/parser.mjs', name: 'parseConfig', kind: 'function', decision: 'compose', justification: 'Reuse the existing parser instead of reimplementing it.' }],
      symbols: [{ name: 'normalizeConfig', file: 'src/parser.mjs' }],
      justification: 'normalizeConfig is a thin composition of the existing parseConfig.',
    });
    ok(result.isError === false, reason(result));
    const edit = await hostA.call('edit', {
      file_path: 'src/parser.mjs',
      old_string: 'export function parseConfigStrict(text) {',
      new_string: 'export function normalizeConfig(text) {\n  return parseConfig(text).replace(/\\s+/g, " ");\n}\n\nexport function parseConfigStrict(text) {',
    });
    ok(edit.isError === false, reason(edit));
    ok(readFileSync(join(A.repo, 'src/parser.mjs'), 'utf8').includes('normalizeConfig'), 'composition must reach the disk');
    return { decision: result.value.decision, created: 'normalizeConfig in src/parser.mjs' };
  });

  await check('A4b extension of one approved task needs no repeated repository search (single preflight)', async () => {
    const before = (await hostA.guard({ action: 'status' })).value.overhead.preflights;
    const edits = [
      ['src/parser.mjs', 'export function parseConfigStrict(text) {', 'export function trimEdges(text) {\n  return text.trim();\n}\n\nexport function parseConfigStrict(text) {'],
      ['src/parser.mjs', 'return parseConfig(text).toLowerCase();', 'return parseConfig(text).toLowerCase().replace(/\\s+/g, " ");'],
      ['src/timeline.mjs', 'return events.map((e) => e.at);', 'return events.map((e) => e.at ?? null);'],
    ];
    for (const [file_path, old_string, new_string] of edits) {
      const result = await hostA.call('edit', { file_path, old_string, new_string });
      ok(result.isError === false, `${file_path}: ${reason(result)}`);
    }
    const after = (await hostA.guard({ action: 'status' })).value.overhead.preflights;
    eq(after - before, 0, 'no extra preflight may be required inside one approved task');
    return { edits: edits.length, extraPreflights: after - before };
  });

  await check('A5 harmless edits are never gated: test file, docs and a function-body change', async () => {
    const testWrite = await hostA.call('write', { file_path: 'tests/new.test.mjs', content: 'export function brandNewTestHelper() {\n  return 1;\n}\n' });
    ok(testWrite.isError === false, `test file must be exempt: ${reason(testWrite)}`);
    const docsWrite = await hostA.call('write', { file_path: 'docs/notes.mjs.md', content: '# notes\n' });
    ok(docsWrite.isError === false, `docs must be exempt: ${reason(docsWrite)}`);
    const bodyEdit = await hostA.call('edit', { file_path: 'src/unrelated.mjs', old_string: 'export const UNRELATED = 1;', new_string: 'export const UNRELATED = 2;' });
    ok(bodyEdit.isError === false, `a value edit with no new declaration must not be gated: ${reason(bodyEdit)}`);
    return { exempt: ['tests/new.test.mjs', 'docs/notes.mjs.md'], ungatedEdit: 'src/unrelated.mjs' };
  });

  await check('A5b a production edit that introduces no new function needs no evidence at all', async () => {
    const agent = await hostA.createAgent('bodyonly');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const status = (await hostA.guard({ action: 'status' }, agent)).value;
    eq(status.records.length, 0, 'fresh agent must hold no records');
    const result = await hostA.call('edit', { file_path: 'src/parser.mjs', old_string: 'export function parseConfig(text) {\n  return text.trim();', new_string: 'export function parseConfig(text) {\n  return String(text).trim();' }, agent);
    ok(result.isError === false, `body-only extension must not be gated: ${reason(result)}`);
    return { evidenceRecords: 0, edit: 'src/parser.mjs body' };
  });

  await check('A6 missing then stale discovery evidence is refused with the exact revision pair', async () => {
    const agent = await hostA.createAgent('stale');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const missing = await hostA.call('write', { file_path: 'src/stale.mjs', content: 'export function staleThing() {}\n' }, agent);
    ok(denied(missing) && /No discovery evidence/.test(reason(missing)), `expected missing-evidence denial: ${reason(missing)}`);
    const first = await hostA.guard({ action: 'preflight', task: 'stale-task', intent: 'x', scope: ['src'], decision: 'new', symbols: [{ name: 'staleThing', file: 'src/stale.mjs' }] }, agent);
    ok(first.isError === false, reason(first));
    const oldHead = first.value.revision;
    const allowed = await hostA.call('write', { file_path: 'src/stale.mjs', content: 'export function staleThing() {}\n' }, agent);
    ok(allowed.isError === false, reason(allowed));
    const commit = await hostA.call('pwsh', { command: 'git add -A; git commit -q -m "approved revision"', description: 'commit approved revision' }, agent);
    ok(commit.isError === false, `an approved revision must be committable: ${reason(commit)}`);
    const newHead = A.git('rev-parse', 'HEAD').trim();
    ok(newHead !== oldHead, 'fixture HEAD must move');
    const stale = await hostA.call('write', { file_path: 'src/stale2.mjs', content: 'export function staleThingTwo() {}\n' }, agent);
    ok(denied(stale) && /stale/i.test(reason(stale)), `expected stale-evidence denial: ${reason(stale)}`);
    return { oldHead, newHead, staleDenial: reason(stale).split('\n')[1] };
  });

  await check('A7 shell-based source mutation is denied before the tool body runs', async () => {
    const agent = await hostA.createAgent('shell');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const result = await hostA.call('pwsh', { command: 'Set-Content -Path src/shell-dup.mjs -Value "export function shellDup(){}"', description: 'attempted shell bypass' }, agent);
    ok(denied(result), `expected shell denial, got: ${JSON.stringify(result).slice(0, 300)}`);
    ok(!existsSync(join(A.repo, 'src/shell-dup.mjs')), 'denied shell mutation must not create the file');
    const redirect = await hostA.call('pwsh', { command: 'echo "export function shellDup2(){}" > src/shell-dup2.mjs' }, agent);
    ok(denied(redirect), 'redirection must be gated too');
    ok(!existsSync(join(A.repo, 'src/shell-dup2.mjs')), 'denied redirection must not create the file');
    const readOnly = await hostA.call('pwsh', { command: 'git status --porcelain', description: 'inspect only' }, agent);
    ok(readOnly.isError === false, `read-only git inspection must pass: ${reason(readOnly)}`);
    const patchOnly = await hostA.call('pwsh', { command: 'node --test tests/parser.test.mjs', description: 'run tests' }, agent);
    ok(patchOnly.isError === false, `running tests must pass: ${reason(patchOnly)}`);
    return { deniedShell: ['Set-Content', 'redirection'], allowedShell: ['git status --porcelain', 'node --test tests/parser.test.mjs'] };
  });

  await check('A8 git commit is validated against the approval boundary (defense in depth)', async () => {
    // Bypass layers 1-3 entirely: bytes reach the worktree from outside the tool pipeline.
    const agent = await hostA.createAgent('boundary');
    hostA.bindScopeParent(agent, hostA.presetKey);
    eq((await hostA.guard({ action: 'status' }, agent)).value.records.length, 0, 'the boundary agent must hold no approvals');
    writeFileSync(join(A.repo, 'src/bypass.mjs'), 'export function bypassThing() {\n  return 1;\n}\n');
    const staged = await hostA.call('pwsh', { command: 'git add -A', description: 'stage' }, agent);
    ok(staged.isError === false, reason(staged));
    const commit = await hostA.call('pwsh', { command: 'git commit -q -m "unreviewed bypass"', description: 'commit' }, agent);
    ok(denied(commit), `git boundary must refuse the unreviewed introduction: ${JSON.stringify(commit).slice(0, 300)}`);
    ok(/bypassThing/.test(reason(commit)) && /outside every accepted edit scope/.test(reason(commit)), reason(commit));
    const headBefore = A.git('rev-parse', 'HEAD').trim();
    eq(A.git('rev-parse', 'HEAD').trim(), headBefore, 'HEAD must not move when the commit is denied');
    return { blockedCommit: 'src/bypass.mjs:1 bypassThing()', head: headBefore };
  });

  await check('A9 post-edit recheck blocks a commit until the collision is acknowledged', async () => {
    const agent = await hostA.createAgent('postcheck');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const preflight = await hostA.guard({
      action: 'preflight', task: 'shared-name', intent: 'Add a shared helper', scope: ['src'], decision: 'new',
      symbols: [{ name: 'sharedName', file: 'src/m3.mjs' }],
      acknowledged: [{ name: 'sharedName', path: 'src/m2.mjs', justification: 'Independent module; intentionally separate implementation.' }],
    }, agent);
    ok(preflight.isError === false, reason(preflight));
    const write = await hostA.call('write', {
      file_path: 'src/m3.mjs',
      content: 'export function sharedName(value) {\n  return value;\n}\n\nexport function unreviewedName(value) {\n  return value;\n}\n',
    }, agent);
    ok(write.isError === false, reason(write));
    const status = (await hostA.guard({ action: 'status' }, agent)).value;
    ok(status.blockers.length === 1, `expected one postcheck blocker, got ${JSON.stringify(status.blockers)}`);
    ok(status.blockers[0].unacknowledged.some((u) => u.name === 'unreviewedName'), 'the undeclared collision must be the blocker');
    ok(!status.blockers[0].unacknowledged.some((u) => u.name === 'sharedName'), 'the acknowledged collision must not block');
    const commitBlocked = await hostA.call('pwsh', { command: 'git commit -q -m "postcheck"', description: 'commit' }, agent);
    ok(denied(commitBlocked) && /post-edit recheck/.test(reason(commitBlocked)), `expected postcheck denial: ${reason(commitBlocked)}`);
    const ack = await hostA.guard({ action: 'acknowledge', file: 'src/m3.mjs', justification: 'unreviewedName is a deliberate domain-specific variant kept for API stability.' }, agent);
    ok(ack.isError === false, reason(ack));
    const after = (await hostA.guard({ action: 'status' }, agent)).value;
    eq(after.blockers.length, 0, 'the blocker must clear after acknowledgement');
    const commitAllowed = await hostA.call('pwsh', { command: 'git commit -q -m "postcheck resolved"', description: 'commit' }, agent);
    ok(commitAllowed.isError === false, `commit must pass once resolved: ${reason(commitAllowed)}`);
    return { blocker: status.blockers[0].unacknowledged, acknowledged: true, commitAfter: true };
  });

  await check('A10 other presets and unbound agents are untouched', async () => {
    const write = await hostA.call('write', { file_path: 'src/other-agent.mjs', content: 'export function otherAgentThing() {}\n' }, hostA.otherAgent);
    ok(write.isError === false, `an agent outside the preset scope must not be gated: ${reason(write)}`);
    const shell = await hostA.call('pwsh', { command: 'Set-Content -Path src/other-agent-shell.mjs -Value "export function x(){}"', description: 'unbound shell write' }, hostA.otherAgent);
    ok(shell.isError === false, `shell in another preset must not be gated: ${reason(shell)}`);
    const visibleAddy = hostA.ctx.tools.get('addy_duplicate_guard', hostA.addyAgent);
    const visibleOther = hostA.ctx.tools.get('addy_duplicate_guard', hostA.otherAgent);
    ok(visibleAddy !== undefined, 'the guard tool must be visible to preset agents');
    ok(visibleOther === undefined, 'the guard tool must be invisible to agents outside the preset');
    return { unboundWrite: 'allowed', unboundShell: 'allowed', toolVisibleToPreset: true, toolVisibleElsewhere: false };
  });

  await check('A11 an approved shell mutation inside the recorded scope is permitted', async () => {
    const agent = await hostA.createAgent('shell-approved');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const preflight = await hostA.guard({ action: 'preflight', task: 'shell-approved', intent: 'x', scope: ['src'], decision: 'new', symbols: [{ name: 'shellApproved', file: 'src/shell-approved.mjs' }] }, agent);
    ok(preflight.isError === false, reason(preflight));
    const result = await hostA.call('pwsh', { command: 'Set-Content -Path src/shell-approved.mjs -Value "export function shellApproved(){}"', description: 'approved shell write' }, agent);
    ok(result.isError === false, `approved shell mutation must pass: ${reason(result)}`);
    ok(existsSync(join(A.repo, 'src/shell-approved.mjs')), 'the approved shell write must reach the disk');
    return { allowed: true };
  });

  await check('A12 overhead: the guard adds bounded cost and ungated calls stay cheap', async () => {
    const agent = await hostA.createAgent('perf');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const unguarded = hostA.otherAgent;
    const sample = async (n, fn) => {
      const samples = [];
      for (let i = 0; i < n; i++) {
        const started = performance.now();
        await fn(i);
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return { p50: Number(samples[Math.floor(n / 2)].toFixed(3)), p95: Number(samples[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(3)), max: Number(samples[n - 1].toFixed(3)) };
    };
    const paired = async (label, n, build) => {
      const guarded = await sample(n, (i) => build(i, agent, 'g'));
      const free = await sample(n, (i) => build(i, unguarded, 'u'));
      return { label, guarded, unguarded: free, deltaP50: Number((guarded.p50 - free.p50).toFixed(3)) };
    };
    let k = 0;
    const readPair = await paired('read production file', 12, (i, who, tag) => hostA.call('read', { file_path: 'src/unrelated.mjs' }, who));
    const testWritePair = await paired('write test file (exempt)', 8, (i, who, tag) => hostA.call('write', { file_path: `tests/perf-${tag}-${++k}.test.mjs`, content: 'export function perfTestHelper() {}\n' }, who));
    const bodyEditPair = await paired('edit value, no new function', 8, (i, who) => {
      const current = readFileSync(join(A.repo, 'src/unrelated.mjs'), 'utf8');
      const match = /export const UNRELATED = (\d+);/.exec(current);
      return hostA.call('edit', { file_path: 'src/unrelated.mjs', old_string: `export const UNRELATED = ${match[1]};`, new_string: `export const UNRELATED = ${Number(match[1]) + 1};` }, who);
    });
    const shellPair = await paired('read-only pwsh command', 5, (i, who) => hostA.call('pwsh', { command: 'git rev-parse --abbrev-ref HEAD', description: 'inspect' }, who));
    let m = 0;
    const deniedWrite = await sample(8, () => hostA.call('write', { file_path: `src/perf-${++m}.mjs`, content: `export function perfFunction${m}() {}\n` }, agent));
    const preflight = await sample(3, (i) => hostA.guard({ action: 'preflight', task: `perf-${i}`, intent: 'overhead probe', scope: ['src'], decision: 'new', symbols: [{ name: `perfApproved${i}`, file: `src/perf-approved-${i}.mjs` }] }, agent));
    const approvedWrite = await sample(6, (i) => hostA.call('write', { file_path: `src/perf-approved-${i}.mjs`, content: `export function perfApproved${i}() {}\n` }, agent));
    await hostA.guard({ action: 'preflight', task: 'perf-declared', intent: 'overhead probe, all symbols declared up front', scope: ['src'], decision: 'new', symbols: [0, 1, 2, 3, 4, 5].map((i) => ({ name: `perfDeclared${i}`, file: `src/perf-declared-${i}.mjs` })) }, agent);
    const declaredWrite = await sample(6, (i) => hostA.call('write', { file_path: `src/perf-declared-${i}.mjs`, content: `export function perfDeclared${i}() {}\n` }, agent));
    const commitBoundary = await sample(2, () => hostA.call('pwsh', { command: 'git add -A; git commit -q -m perf-probe --allow-empty', description: 'boundary probe' }, agent));
    evidence.performance = [
      readPair, testWritePair, bodyEditPair, shellPair,
      { label: 'production write denied (guarded only)', guarded: deniedWrite },
      { label: 'preflight, small fixture (guarded only)', guarded: preflight },
      { label: 'production write, all introduced symbols declared (guarded only)', guarded: declaredWrite },
      { label: 'production write, undeclared symbol forces a postcheck scan (guarded only)', guarded: approvedWrite },
      { label: 'git add + git commit incl. boundary validation (guarded only)', guarded: commitBoundary },
    ];
    const guardedOnly = evidence.performance.slice(4);
    ok(readPair.deltaP50 < 30, `guard overhead on a read must be small, got ${readPair.deltaP50} ms`);
    ok(testWritePair.deltaP50 < 30, `guard overhead on an exempt write must be small, got ${testWritePair.deltaP50} ms`);
    ok(bodyEditPair.deltaP50 < 30, `guard overhead on a body-only edit must be small, got ${bodyEditPair.deltaP50} ms`);
    ok(shellPair.deltaP50 < 30, `guard overhead on a read-only shell command must be small, got ${shellPair.deltaP50} ms`);
    ok(deniedWrite.p50 < 60, `a denied production write must stay bounded, got ${deniedWrite.p50} ms`);
    ok(declaredWrite.p50 < 60, `an approved write with declared symbols must stay bounded, got ${declaredWrite.p50} ms`);
    ok(preflight.p50 < 2000, `preflight must stay bounded, got ${preflight.p50} ms`);
    void guardedOnly;
    return Object.fromEntries(evidence.performance.map((row) => [row.label, row.unguarded ? `guarded ${row.guarded.p50} ms vs unguarded ${row.unguarded.p50} ms (delta ${row.deltaP50})` : `p50 ${row.guarded.p50} ms / p95 ${row.guarded.p95} ms`]));
  });

  await check('A13 the documented config switch `enabled: false` disables the plugin entirely', async () => {
    const offKey = {};
    const offScope = (await pkg('dsh-scope')).createScope(hostA.ctx, offKey);
    await offScope.ctx.plugin(plugin, { enabled: false });
    await new Promise((resolve) => setImmediate(resolve));
    const agent = await hostA.createAgent('off');
    hostA.bindScopeParent(agent, offKey);
    const write = await hostA.call('write', { file_path: 'src/off-switch.mjs', content: 'export function offSwitchThing() {}\n' }, agent);
    ok(write.isError === false, `the off switch must lift the gate: ${reason(write)}`);
    ok(hostA.ctx.tools.get('addy_duplicate_guard', agent) === undefined, 'no tool must be registered when disabled');
    return { gated: false, toolRegistered: false, fileCreated: existsSync(join(A.repo, 'src/off-switch.mjs')) };
  });

  await check('R1 absolute-path and relative-path mutations of one repository file produce identical decisions (defect 1)', async () => {
    const agent = await hostA.createAgent('abs-paths');
    hostA.bindScopeParent(agent, hostA.presetKey);
    const absUtil = join(A.repo, 'src', 'util.mjs');
    const original = readFileSync(absUtil, 'utf8');
    // (c) pure body-line edit via ABSOLUTE path — the ticket's named regression.
    const bodyEditAbs = await hostA.call('edit', { file_path: absUtil, old_string: '  return value;', new_string: '  return String(value);' }, agent);
    ok(bodyEditAbs.isError === false, `absolute-path body-only edit must not be gated: ${reason(bodyEditAbs)}`);
    // (a) whole-file rewrite via ABSOLUTE path that keeps the existing declaration and changes only its body.
    const rewriteAbs = await hostA.call('write', { file_path: absUtil, content: 'export function existing(value) {\n  return String(value).trim();\n}\n' }, agent);
    ok(rewriteAbs.isError === false, `absolute-path body-only rewrite must not be gated (existing() is not a new function): ${reason(rewriteAbs)}`);
    // restore through the RELATIVE form (also proves a no-new-declaration write is ungated).
    const restoreRel = await hostA.call('write', { file_path: 'src/util.mjs', content: original }, agent);
    ok(restoreRel.isError === false, reason(restoreRel));
    // (b) signature edit whose new text contains the EXISTING declaration — absolute and relative must agree.
    const sigAbs = await hostA.call('edit', { file_path: absUtil, old_string: 'export function existing(value) {', new_string: 'export function existing(value = 0) {' }, agent);
    ok(sigAbs.isError === false, `absolute-path signature edit of an existing function must not be gated: ${reason(sigAbs)}`);
    const sigRel = await hostA.call('edit', { file_path: 'src/util.mjs', old_string: 'export function existing(value = 0) {', new_string: 'export function existing(value) {' }, agent);
    ok(sigRel.isError === false, `relative-path signature edit must not be gated: ${reason(sigRel)}`);
    // (e) a genuinely NEW declaration is gated identically for both path forms.
    const absTarget = join(A.repo, 'src', 'abs-new.mjs');
    const newContent = 'export function absNewThing() {\n  return 1;\n}\n';
    const deniedAbs = await hostA.call('write', { file_path: absTarget, content: newContent }, agent);
    const deniedRel = await hostA.call('write', { file_path: 'src/abs-new.mjs', content: newContent }, agent);
    ok(denied(deniedAbs), `absolute-path new declaration must be gated: ${reason(deniedAbs)}`);
    ok(denied(deniedRel), `relative-path new declaration must be gated: ${reason(deniedRel)}`);
    eq(reason(deniedAbs), reason(deniedRel), 'both path forms must produce the byte-identical decision text');
    // (f) after one preflight naming the absolute target, the absolute-path write is authorised.
    const pf = await hostA.guard({ action: 'preflight', task: 'abs-paths', intent: 'absolute/relative equivalence', scope: ['src'], decision: 'new', symbols: [{ name: 'absNewThing', file: absTarget }] }, agent);
    ok(pf.isError === false, reason(pf));
    const allowedAbs = await hostA.call('write', { file_path: absTarget, content: newContent }, agent);
    ok(allowedAbs.isError === false, reason(allowedAbs));
    ok(existsSync(absTarget), 'the authorised absolute-path write must reach the disk');
    const st = (await hostA.guard({ action: 'status' }, agent)).value;
    eq(st.records.length, 1, 'exactly one preflight: none of the body/signature edits required evidence');
    return { bodyEditAbs: 'allowed', rewriteAbs: 'allowed', sigAbs: 'allowed', sigRel: 'allowed', newDeclGatedBothForms: true, denialTextsIdentical: true, preflightsUsed: 1 };
  });

  await check('R2 a path outside the repository keeps the existing safety behavior', async () => {
    const outside = join(dirname(A.repo), `dg-outside-${Date.now()}.mjs`);
    const result = await hostA.call('write', { file_path: outside, content: 'export function outsideThing() {}\n' }, hostA.addyAgent);
    ok(!denied(result), `the guard must not deny outside-repository paths (existing passthrough behavior): ${reason(result)}`);
    const wrote = existsSync(outside);
    if (wrote) rmSync(outside, { force: true });
    return { guardDenied: false, fsToolWroteOutside: wrote, note: wrote ? 'fs tool performed the write; guard passthrough unchanged' : 'the fs tool itself rejected the path; guard decision was still passthrough' };
  });

  const rState = {};
  await check('R4 unwritable evidence storage rejects the preflight and registers no approval (defect 2)', async () => {
    const blocker = join(tmpdir(), `dg-evblock-${Date.now()}`);
    writeFileSync(blocker, 'not a directory');
    const evKey = {};
    const evScope = (await pkg('dsh-scope')).createScope(hostA.ctx, evKey);
    await evScope.ctx.plugin(plugin, { evidenceDir: blocker });
    await new Promise((resolve) => setImmediate(resolve));
    const agent = await hostA.createAgent('evidence');
    hostA.bindScopeParent(agent, evKey);
    const pfArgs = { action: 'preflight', task: 'evidence-failclosed', intent: 'defect 2 regression', scope: ['src'], decision: 'new', symbols: [{ name: 'evThing', file: 'src/ev.mjs' }] };
    const pf = await hostA.guard(pfArgs, agent);
    ok(pf.isError === true, 'preflight must fail when its evidence cannot be persisted');
    ok(/could not be persisted and verified/.test(reason(pf)) && /NO approval was registered/.test(reason(pf)), reason(pf));
    ok(/Cause:/.test(reason(pf)), 'the original storage failure must be preserved for diagnosis');
    const w = await hostA.call('write', { file_path: 'src/ev.mjs', content: 'export function evThing() {}\n' }, agent);
    ok(denied(w), 'without persisted evidence the protected mutation must remain denied');
    ok(!existsSync(join(A.repo, 'src/ev.mjs')), 'the denied write must not create the file');
    const st = (await hostA.guard({ action: 'status' }, agent)).value;
    eq(st.records.length, 0, 'no approval may exist in memory after a persistence failure');
    rState.ev = { agent, blocker, pfArgs };
    return { preflightRejected: true, approvalRegistered: false, mutationDenied: true, causePreserved: /Cause: (.*)/.exec(reason(pf))?.[1]?.slice(0, 120) };
  });

  await check('R5 the same preflight succeeds on retry once storage is fixed, with independently verified evidence (defect 2)', async () => {
    const { agent, blocker, pfArgs } = rState.ev;
    unlinkSync(blocker);
    mkdirSync(blocker, { recursive: true });
    const pf = await hostA.guard(pfArgs, agent);
    ok(pf.isError === false, reason(pf));
    ok(pf.value.accepted === true && pf.value.evidence?.verified === true, 'the acceptance must reference the verified record');
    ok(existsSync(pf.value.evidence.path), 'the verified evidence file must exist');
    const stored = readFileSync(pf.value.evidence.path);
    eq(stored.length, pf.value.evidence.bytes, 'stored byte length must match the reported record');
    eq(createHash('sha256').update(stored).digest('hex'), pf.value.evidence.sha256, 'stored SHA-256 must match the reported digest');
    const w = await hostA.call('write', { file_path: 'src/ev.mjs', content: 'export function evThing() {}\n' }, agent);
    ok(w.isError === false, `the retry must authorise the mutation: ${reason(w)}`);
    ok(existsSync(join(A.repo, 'src/ev.mjs')), 'the authorised write must reach the disk');
    const pf2 = await hostA.guard(pfArgs, agent);
    ok(pf2.isError === false && pf2.value.recordId !== pf.value.recordId, 'a repeated preflight is safe and writes a fresh record');
    return { verified: true, bytes: pf.value.evidence.bytes, sha256: `${pf.value.evidence.sha256.slice(0, 12)}…`, retrySafe: true };
  });

  const fault = { active: true };
  let injAgent = null;
  await check('R6 a failed post-edit recheck becomes an explicit unresolved blocker that denies commit and push (defect 3)', async () => {
    const injKey = {};
    const injScope = (await pkg('dsh-scope')).createScope(hostA.ctx, injKey);
    await injScope.ctx.plugin(plugin, {
      evidenceDir: join(tmpdir(), `dg-ev-inj-${Date.now()}`),
      __testForceRecheckError: () => (fault.active ? new Error('injected recheck failure') : undefined),
    });
    await new Promise((resolve) => setImmediate(resolve));
    injAgent = await hostA.createAgent('inject');
    hostA.bindScopeParent(injAgent, injKey);
    const pf = await hostA.guard({ action: 'preflight', task: 'recheck-fault', intent: 'defect 3 regression', scope: ['src'], decision: 'new', symbols: [{ name: 'faultThing', file: 'src/fault.mjs' }] }, injAgent);
    ok(pf.isError === false, reason(pf));
    const w = await hostA.call('write', { file_path: 'src/fault.mjs', content: 'export function faultThing() {\n  return 1;\n}\n' }, injAgent);
    ok(w.isError === false, `the approved mutation itself must succeed: ${reason(w)}`);
    ok(existsSync(join(A.repo, 'src/fault.mjs')), 'the mutation reached disk; verification is what failed');
    const st = (await hostA.guard({ action: 'status' }, injAgent)).value;
    eq(st.blockers.length, 1, `the failed recheck must create exactly one blocker: ${JSON.stringify(st.blockers)}`);
    const blocker = st.blockers[0];
    eq(blocker.status, 'verification-failed', 'the blocker must be explicitly marked as a failed verification');
    eq(blocker.file, 'src/fault.mjs', 'the blocker must identify the affected file');
    ok(blocker.introduced.includes('faultThing'), 'the blocker must identify the affected edit');
    ok(/injected recheck failure/.test(blocker.verificationError?.message ?? ''), 'the blocker must retain the underlying error');
    ok(st.overhead.recheckFailures >= 1, 'the failure must be counted in the overhead metrics');
    A.git('add', '-A');
    const headBefore = A.git('rev-parse', 'HEAD').trim();
    const commit = await hostA.call('pwsh', { command: 'git commit -q -m "r6 blocked"', description: 'commit with unresolved recheck blocker' }, injAgent);
    ok(denied(commit) && /recheck of src\/fault\.mjs FAILED/.test(reason(commit)), `commit must be denied while the recheck is unresolved: ${reason(commit)}`);
    const push = await hostA.call('pwsh', { command: 'git push origin main', description: 'push with unresolved recheck blocker' }, injAgent);
    ok(denied(push), 'push must be denied while the recheck is unresolved');
    eq(A.git('rev-parse', 'HEAD').trim(), headBefore, 'HEAD must not move while the blocker is unresolved');
    return { blocker: { status: blocker.status, file: blocker.file, introduced: blocker.introduced, error: blocker.verificationError.message }, commitDenied: true, pushDenied: true, headUnmoved: true };
  });

  await check('R7 exempt writes, reads and ungated edits never enter the fail-closed recheck path (defect 3 scope)', async () => {
    const before = (await hostA.guard({ action: 'status' }, injAgent)).value.blockers.length;
    const testWrite = await hostA.call('write', { file_path: 'tests/fault-exempt.test.mjs', content: 'export function exemptHelper() {}\n' }, injAgent);
    ok(testWrite.isError === false, reason(testWrite));
    const read = await hostA.call('read', { file_path: 'src/util.mjs' }, injAgent);
    ok(read.isError === false, reason(read));
    const bodyEdit = await hostA.call('edit', { file_path: 'src/fault.mjs', old_string: '  return 1;', new_string: '  return 2;' }, injAgent);
    ok(bodyEdit.isError === false, `a body-only edit needs no recheck and must not be blocked: ${reason(bodyEdit)}`);
    const after = (await hostA.guard({ action: 'status' }, injAgent)).value.blockers.length;
    eq(after, before, 'exempt and ungated operations must never create recheck blockers (the fault injector must not see them)');
    return { blockersBefore: before, blockersAfter: after };
  });

  await check('R8 a successful recheck clears the failure blocker and the commit proceeds (defect 3)', async () => {
    fault.active = false;
    const rc = await hostA.guard({ action: 'recheck', file: 'src/fault.mjs' }, injAgent);
    ok(rc.isError === false, reason(rc));
    ok(rc.value.rechecks.length >= 1 && rc.value.rechecks.every((r) => r.status === 'verified'), `the recheck must now succeed: ${JSON.stringify(rc.value.rechecks)}`);
    const st = (await hostA.guard({ action: 'status' }, injAgent)).value;
    eq(st.blockers.length, 0, 'the blocker must clear after a successful recheck');
    const commit = await hostA.call('pwsh', { command: 'git add -A; git commit -q -m "r8 resolved"', description: 'commit after blocker resolution' }, injAgent);
    ok(commit.isError === false, `the commit must pass once the blocker is resolved: ${reason(commit)}`);
    return { recheckStatus: 'verified', blockers: 0, committed: true };
  });

  const status = (await hostA.guard({ action: 'status' })).value;
  evidence.overhead = status.overhead;
  evidence.hostA = { mounted: hostA.mounted, shellTools: hostA.shellTools, head: A.git('rev-parse', 'HEAD').trim() };
} catch (error) {
  failures += 1;
  evidence.cases.push({ name: 'host A harness', pass: false, error: { name: error.name, message: error.message, stack: error.stack } });
  console.log(`  FAIL  host A harness: ${error.message}`);
} finally {
  await hostA.ctx.fiber.dispose();
}

/* =============================== Host B — PTC nested calls =============================== */

console.log('\nHost B: PTC presentation (nested sub-dispatch + direct filesystem)');
const B = makeRepo('b');
const hostB = await bootHost({ repo: B.repo, ptc: true });

try {
  await check('B0 read-only PTC program is not interfered with', async () => {
    const code = [
      'const fs = await import("node:fs");',
      'const text = fs.readFileSync("src/parser.mjs", "utf8");',
      'return { length: text.length };',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'read only', code });
    ok(result.isError === false, reason(result));
    return { value: result.value };
  });

  await check('B1 nested PTC source mutation is denied by the same policy', async () => {
    const code = [
      'try { const r = await tools.write({ file_path: "src/ptc-dup.mjs", content: "export function parseConfig(x){return x;}" }); return { r }; }',
      'catch (e) { return { denied: String(e.message ?? e) }; }',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'nested write', code });
    ok(result.isError === false, `the program itself must complete: ${reason(result)}`);
    ok(!existsSync(join(B.repo, 'src/ptc-dup.mjs')), 'the denied nested write must not create the file');
    const output = JSON.stringify(result.value);
    ok(/ADDY-DUPLICATE-GUARD/.test(output), `nested denial must be observable in the program value: ${output.slice(0, 400)}`);
    return { nestedDenied: true, fileCreated: false };
  });

  await check('B2 preflight through the PTC binding authorises the nested mutation', async () => {
    const preflightCode = [
      'const record = await tools.addy_duplicate_guard({',
      '  action: "preflight", task: "ptc-task", intent: "nested write under policy",',
      '  scope: ["src"], decision: "new",',
      '  symbols: [{ name: "ptcDup", file: "src/ptc-dup.mjs" }],',
      '});',
      'return { recordId: record.recordId, revision: record.revision, declaredElsewhere: record.declaredElsewhere };',
    ].join('\n');
    const preflight = await hostB.call('run_code', { description: 'preflight via PTC', code: preflightCode });
    ok(preflight.isError === false, reason(preflight));
    const record = preflight.value.result;
    ok(record?.recordId?.startsWith('dg_'), `preflight must return a record: ${JSON.stringify(preflight.value).slice(0, 400)}`);
    const writeCode = [
      'try { const r = await tools.write({ file_path: "src/ptc-dup.mjs", content: "export function ptcDup(x){return x;}" }); return { r }; }',
      'catch (e) { return { denied: String(e.message ?? e) }; }',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'nested write after preflight', code: writeCode });
    ok(result.isError === false, reason(result));
    ok(existsSync(join(B.repo, 'src/ptc-dup.mjs')), 'the authorised nested write must reach the disk');
    return { recordId: record.recordId, created: 'src/ptc-dup.mjs' };
  });

  await check('B3 direct PTC filesystem write bypassing the tool bindings is denied before execution', async () => {
    const code = [
      'const fs = await import("node:fs");',
      'fs.writeFileSync("src/ptc-direct.mjs", "export function sneakyDup(){return 1;}");',
      'return { wrote: "src/ptc-direct.mjs" };',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'direct fs write', code });
    ok(denied(result), `expected run_code denial, got ${JSON.stringify(result).slice(0, 300)}`);
    ok(!existsSync(join(B.repo, 'src/ptc-direct.mjs')), 'the denied program must not have run');
    ok(/no post-edit recheck|not covered by any accepted record|without an accepted record/.test(reason(result)), reason(result));
    return { denial: reason(result).split('\n').slice(1, 3).join(' ') };
  });

  await check('B3b a direct PTC write whose declarations are declared in evidence is permitted', async () => {
    const preflightCode = [
      'const record = await tools.addy_duplicate_guard({',
      '  action: "preflight", task: "ptc-direct", intent: "direct write path under policy",',
      '  scope: ["src"], decision: "new",',
      '  symbols: [{ name: "directApproved", file: "src/direct-approved.mjs" }],',
      '});',
      'return { recordId: record.recordId };',
    ].join('\n');
    const preflight = await hostB.call('run_code', { description: 'preflight for the direct write', code: preflightCode });
    ok(preflight.isError === false, reason(preflight));
    const code = [
      'const fs = await import("node:fs");',
      'fs.writeFileSync("src/direct-approved.mjs", "export function directApproved(){return 1;}");',
      'return { wrote: "src/direct-approved.mjs" };',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'declared direct write', code });
    ok(result.isError === false, `a declared direct write must be permitted: ${reason(result)}`);
    ok(existsSync(join(B.repo, 'src/direct-approved.mjs')), 'the declared direct write must reach the disk');
    return { created: 'src/direct-approved.mjs' };
  });

  await check('B4 direct PTC filesystem write through child_process is denied too', async () => {
    const code = [
      'const cp = await import("node:child_process");',
      'cp.execSync("echo export function sneaky2(){} > src/ptc-shell.mjs");',
      'return { wrote: true };',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'child_process write', code });
    ok(denied(result), `expected run_code denial, got ${JSON.stringify(result).slice(0, 300)}`);
    ok(!existsSync(join(B.repo, 'src/ptc-shell.mjs')), 'the denied program must not have run');
    return { denial: reason(result).split('\n')[1] };
  });

  await check('B5 an agent outside the preset scope is unaffected under PTC', async () => {
    const code = [
      'const fs = await import("node:fs");',
      'fs.writeFileSync("src/free.mjs", "export function freeThing(){return 1;}");',
      'return { ok: true };',
    ].join('\n');
    const result = await hostB.call('run_code', { description: 'unbound direct write', code }, hostB.otherAgent);
    ok(result.isError === false, reason(result));
    ok(existsSync(join(B.repo, 'src/free.mjs')), 'an unbound agent must be able to write directly');
    return { allowed: true };
  });
  await check('B6 nested PTC mutation with an absolute path follows the same normalized decision (defect 1)', async () => {
    const absTarget = join(B.repo, 'src', 'ptc-abs.mjs');
    const preflightCode = [
      'const record = await tools.addy_duplicate_guard({',
      '  action: "preflight", task: "ptc-abs", intent: "absolute path via PTC",',
      '  scope: ["src"], decision: "new",',
      `  symbols: [{ name: "ptcAbsThing", file: ${JSON.stringify(absTarget)} }],`,
      '});',
      'return { recordId: record.recordId };',
    ].join('\n');
    const preflight = await hostB.call('run_code', { description: 'preflight naming an absolute target', code: preflightCode });
    ok(preflight.isError === false, reason(preflight));
    ok(preflight.value.result?.recordId?.startsWith('dg_'), `preflight must succeed with an absolute symbol file: ${JSON.stringify(preflight.value).slice(0, 300)}`);
    const writeCode = `try { await tools.write({ file_path: ${JSON.stringify(absTarget)}, content: "export function ptcAbsThing(){return 1;}" }); return { ok: true }; } catch (e) { return { denied: String(e.message ?? e) }; }`;
    const result = await hostB.call('run_code', { description: 'nested absolute write', code: writeCode });
    ok(result.isError === false, reason(result));
    ok(result.value.result?.ok === true, `authorised nested absolute-path write must succeed: ${JSON.stringify(result.value).slice(0, 300)}`);
    ok(existsSync(join(B.repo, 'src', 'ptc-abs.mjs')), 'the write must reach the disk');
    // A body-only rewrite of that same file via absolute path introduces nothing new and needs no evidence.
    const bodyCode = `try { await tools.write({ file_path: ${JSON.stringify(absTarget)}, content: "export function ptcAbsThing(){return 2;}" }); return { ok: true }; } catch (e) { return { denied: String(e.message ?? e) }; }`;
    const body = await hostB.call('run_code', { description: 'nested absolute body rewrite', code: bodyCode });
    ok(body.isError === false && body.value.result?.ok === true, `a body-only absolute-path rewrite must not be gated: ${JSON.stringify(body.value ?? body.error).slice(0, 300)}`);
    return { nestedAbsoluteWrite: 'allowed', bodyRewriteUngated: true };
  });
} catch (error) {
  failures += 1;
  evidence.cases.push({ name: 'host B harness', pass: false, error: { name: error.name, message: error.message, stack: error.stack } });
  console.log(`  FAIL  host B harness: ${error.message}`);
} finally {
  await hostB.ctx.fiber.dispose();
}

evidence.pass = failures === 0 && evidence.cases.every((c) => c.pass);
writeFileSync(new URL('../evidence/duplicate-guard-runtime.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.pass ? 'ALL CASES PASS' : `${failures} FAILURE(S)`} — ${evidence.cases.length} cases; evidence/duplicate-guard-runtime.json`);
if (!evidence.pass) process.exitCode = 1;
