/**
 * addy-duplicate-guard — policy unit suite and scale benchmark.
 *
 * Every acceptance case is asserted twice: once against the pure policy
 * functions (fast, exhaustive, no host) and once against the real DSH runtime
 * in duplicate-guard-runtime.mjs. This file also measures the repository scan
 * at a realistic scale, because that cost dominates the whole feature.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as core from '../duplicate-guard-core.mjs';

const evidence = { testedAt: new Date().toISOString(), nodeVersion: process.version, cases: [], benchmark: null };
let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    evidence.cases.push({ name, pass: true, detail: detail ?? null });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    evidence.cases.push({ name, pass: false, error: { name: error.name, message: error.message } });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}
const ok = (v, m) => { if (!v) throw new Error(m ?? `expected truthy, got ${JSON.stringify(v)}`); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m ?? 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

const parser = 'export function parseConfig(text) {\n  return text.trim();\n}\n';
const withDup = `${parser}\nexport function parseConfigExtra(text) {\n  return text;\n}\n`;

console.log('\nPolicy unit suite');

check('path classification: production vs test, docs, config, declarations, build output', () => {
  eq(core.classifyPath('src/parser.ts').production, true, 'src/parser.ts');
  eq(core.classifyPath('packages/core/src/thing.mjs').production, true, 'nested package source');
  eq(core.classifyPath('tests/parser.test.ts').production, false, 'test segment');
  eq(core.classifyPath('src/parser.spec.ts').production, false, 'spec basename');
  eq(core.classifyPath('src/parser.test.mjs').production, false, 'test basename');
  eq(core.classifyPath('src/types.d.ts').production, false, 'declaration file');
  eq(core.classifyPath('src/vite.config.ts').production, false, 'config basename');
  eq(core.classifyPath('docs/readme.md').production, false, 'docs');
  eq(core.classifyPath('dist/bundle.js').production, false, 'build output');
  eq(core.classifyPath('node_modules/x/index.js').production, false, 'dependency');
  eq(core.classifyPath('conftest.py').production, false, 'python test config');
  eq(core.classifyPath('/etc/passwd').production, false, 'absolute path');
  eq(core.classifyPath('src/thing.py', { exemptPaths: ['src'] }).production, false, 'configured exemption');
  return { productionExtensions: core.PRODUCTION_EXT.size };
});

check('symbol extraction across languages is stable and comment/string aware', () => {
  const js = core.extractSymbols('// function commented(){}\nconst s = "function inString(){}";\nexport async function real(a) {\n}\nclass A {\n  async handle(e) {\n  }\n}\nif (x) { }\nfor (const a of b) { }\n', 'src/a.ts');
  eq(js.map((s) => s.name).join(','), 'real,handle', 'javascript extraction');
  eq(core.extractSymbols('async def do_thing(x):\n    pass\n', 'src/a.py').map((s) => s.name).join(','), 'do_thing', 'python');
  eq(core.extractSymbols('func DoThing(a int) error {\n}\n', 'src/a.go').map((s) => s.name).join(','), 'DoThing', 'go');
  eq(core.extractSymbols('pub async fn do_thing() {\n}\n', 'src/a.rs').map((s) => s.name).join(','), 'do_thing', 'rust');
  eq(core.extractSymbols('public static int Compute(int a) {\n}\n', 'src/A.java').map((s) => s.name).join(','), 'Compute', 'java');
  eq(core.extractSymbols('def helper\nend\n', 'src/a.rb').map((s) => s.name).join(','), 'helper', 'ruby');
  eq(core.extractSymbols('export function a(){}\nexport function b(){}\n', 'x.ts').length, 2, 'two declarations');
  eq(core.introducedSymbols(parser, withDup, 'src/parser.mjs').map((s) => s.name).join(','), 'parseConfigExtra', 'introduced diff');
  eq(core.introducedSymbols(withDup, withDup, 'src/parser.mjs').length, 0, 'identical content introduces nothing');
  return { js, symbols: core.extractSymbols(withDup, 'src/parser.mjs').length };
});

check('declaredNamesInText finds declarations carried inside command and program strings', () => {
  const names = core.declaredNamesInText('Set-Content src/a.ts "export function dupThing(){}"');
  eq(names.join(','), 'dupThing', 'shell payload');
  eq(core.declaredNamesInText('const s = `export function inner(){}`;').join(','), 'inner', 'template literal');
  eq(core.declaredNamesInText('git status --porcelain').length, 0, 'no declarations');
  return { names };
});

check('acceptance 1: a new function whose equivalent exists is detected, never silently allowed', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    const scan = core.scanRepository({ root, names: ['parseConfig'] });
    eq(scan.declarations.parseConfig.length, 1, 'the existing declaration must be found');
    eq(scan.declarations.parseConfig[0].path, 'src/parser.mjs', 'declaration path');
    const mutation = core.analyzeFsMutation({ toolName: 'write', args: { file_path: 'src/other.mjs', content: 'export function parseConfig(){}\n' } }, () => ({ exists: false, content: '' }));
    eq(mutation.introduced.length, 1, 'the write introduces a function');
    return { found: scan.declarations.parseConfig, introduced: mutation.introduced };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('acceptance 2: a new function with no equivalent is permitted by a clean scan', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    const scan = core.scanRepository({ root, names: ['renderTimeline'] });
    eq(scan.declarations.renderTimeline.length, 0, 'no equivalent declaration');
    eq(scan.references.renderTimeline.length, 0, 'no references either');
    eq(scan.truncated, false, 'a small repository must not be truncated');
    return { filesScanned: scan.filesScanned, references: 0 };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('acceptance 3: a different function with a similar name is reported, not rejected', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    const scan = core.scanRepository({ root, names: ['parseConfigFile'] });
    eq(scan.declarations.parseConfigFile.length, 0, 'a similar name is not an equivalent declaration');
    ok(scan.similar.parseConfigFile.some((s) => s.name === 'parseConfig' && s.score >= 0.5), `expected a similarity candidate, got ${JSON.stringify(scan.similar.parseConfigFile)}`);
    return { similar: scan.similar.parseConfigFile };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('acceptance 4: extension and composition are expressible as a candidate decision', () => {
  const record = { decision: 'compose', candidates: [{ path: 'src/parser.mjs', name: 'parseConfig' }], symbols: ['normalizeConfig'] };
  ok(['reuse', 'extend', 'compose'].includes(record.decision), 'a non-new decision is representable');
  ok(record.candidates.length > 0, 'a composition decision must name an existing candidate');
  const extension = core.introducedSymbols(parser, `${parser}\nexport function normalizeConfig(t){ return parseConfig(t); }\n`, 'src/parser.mjs');
  eq(extension.length, 1, 'a composition helper is still an introduced function and is therefore scanned');
  const bodyOnly = core.introducedSymbols(parser, parser.replace('return text.trim();', 'return String(text).trim();'), 'src/parser.mjs');
  eq(bodyOnly.length, 0, 'extending a body introduces no function and needs no evidence');
  return { extension: extension.map((s) => s.name), bodyOnly: 0 };
});

check('acceptance 5: one record authorises every edit inside its scope at its revision', () => {
  const record = { revision: 'abc', scope: core.normalizeScopeEntry('src') ? ['src'] : [] };
  ok(core.pathInScope('src/a.ts', record.scope), 'in scope');
  ok(core.pathInScope('src/deep/nested/b.ts', record.scope), 'in scope, nested');
  ok(!core.pathInScope('tests/a.ts', record.scope), 'outside scope');
  ok(!core.pathInScope('srcish/a.ts', record.scope), 'prefix must respect a path boundary');
  eq(core.normalizeScopeEntry('C:/x'), null, 'absolute scope entries are rejected');
  eq(core.normalizeScopeEntry('../up'), null, 'parent traversal is rejected');
  eq(core.normalizeScopeEntry('./src/'), 'src', 'normalisation');
  return { scope: record.scope };
});

check('acceptance 6: missing and stale discovery evidence are distinguishable', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    const head = core.gitHead(root);
    ok(/^[0-9a-f]{40}$/.test(head), `git head must be readable: ${head}`);
    eq(core.repositoryRoot(join(root, 'src')), core.repositoryRoot(root), 'nested directory resolves to the repository root');
    writeFileSync(join(root, 'src/new.mjs'), 'export function newlyAdded(){}\n');
    const boundary = core.gitBoundaryIntroduced({ root, head, isPathApproved: () => false });
    ok(boundary.introduced.some((i) => i.name === 'newlyAdded'), `untracked introduction must be detected: ${JSON.stringify(boundary)}`);
    eq(boundary.outsideScope.length, boundary.introduced.length, 'with no approval everything is outside scope');
    const approved = core.gitBoundaryIntroduced({ root, head, isPathApproved: (rel) => rel === 'src/new.mjs' });
    eq(approved.outsideScope.length, 0, 'an approved path is inside scope');
    return { head, introduced: boundary.introduced };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('acceptance 7: nested PTC and shell mutation surfaces are all classified', () => {
  const fsWrite = core.analyzeRunCode('const fs = await import("node:fs");\nfs.writeFileSync("src/a.ts", "x");');
  ok(fsWrite.gated, 'direct fs write under PTC is gated');
  eq(fsWrite.writePrimitives.join(','), 'writeFileSync', 'primitive named');
  const fsRead = core.analyzeRunCode('const fs = await import("node:fs");\nconst t = fs.readFileSync("src/a.ts", "utf8");');
  ok(!fsRead.gated, 'a read-only program is never gated');
  const processWrite = core.analyzeRunCode('const cp = await import("node:child_process");\ncp.execSync("echo x > src/a.ts");');
  ok(processWrite.gated, 'child_process mutation is gated');
  const assembled = core.analyzeRunCode('const fs = await import("node:fs");\nconst p = ["src/", "a", ".ts"].join("");\nfs.writeFileSync(p, "x");');
  ok(!assembled.gated, 'DOCUMENTED RESIDUAL: a path assembled at runtime from fragments is not gated by this layer; the git-boundary check is the backstop');
  const nested = core.analyzeRunCode('const r = await tools.write({ file_path: "src/a.ts", content: "export function f(){}" });');
  ok(!nested.gated, 'a nested tool call is gated by the nested tool name, not by the program scan');
  return { fsWrite, fsRead: fsRead.gated, processWrite: processWrite.gated, assembledPathGated: assembled.gated, nestedProgramGated: nested.gated };
});

check('acceptance 8: every shell write surface maps to a gate decision', () => {
  const cases = {
    'Set-Content src/a.ts "export function d(){}"': true,
    'echo "export function d(){}" > src/a.ts': true,
    'Add-Content -Path src/a.ts -Value "function d(){}"': true,
    'Out-File -FilePath src/a.ts -InputObject "function d(){}"': true,
    'python -c "open(\'src/a.ts\',\'w\').write(\'def f(): pass\')"': true,
    'node -e "require(\'node:fs\').writeFileSync(\'src/a.ts\',\'function f(){}\')"': true,
    '[IO.File]::WriteAllText("src/a.ts", "function f(){}")': true,
    'sed -i "s/a/b/" src/a.ts': true,
    'tee src/a.ts': true,
    'git apply patch.diff': true,
    'node --test tests/core.test.mjs': false,
    'git status --porcelain': false,
    'npm ci': false,
    'npx prettier --write src/a.ts': false,
    'rg "function" src/': false,
  };
  const table = {};
  for (const [command, expected] of Object.entries(cases)) {
    const analysis = core.analyzeShellCommand(command);
    table[command] = analysis.gated;
    eq(analysis.gated, expected, `gated(${command})`);
  }
  eq(core.analyzeShellCommand('git commit -m "x"').gitCommit, true, 'git commit detected');
  eq(core.analyzeShellCommand('git push origin main').gitPush, true, 'git push detected');
  ok(core.refMutatingGit('git merge --ff-only x'), 'ref-moving git detected');
  ok(!core.refMutatingGit('git status'), 'read-only git is not ref-moving');
  return table;
});

check('acceptance 9: the git boundary reads added lines, not whole files', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    const head = core.gitHead(root);
    // Move an existing declaration inside the file: not a new function.
    writeFileSync(join(root, 'src/parser.mjs'), `// moved\n${parser}`);
    eq(core.gitBoundaryIntroduced({ root, head, isPathApproved: () => false }).introduced.length, 0, 'a moved declaration is not an introduction');
    writeFileSync(join(root, 'src/parser.mjs'), `${parser}\nexport function addedLater(){}\n`);
    const boundary = core.gitBoundaryIntroduced({ root, head, isPathApproved: () => false });
    ok(boundary.introduced.some((i) => i.name === 'addedLater'), `added declaration must be detected: ${JSON.stringify(boundary.introduced)}`);
    ok(!boundary.introduced.some((i) => i.name === 'parseConfig'), 'pre-existing declarations must not be reported');
    return { introduced: boundary.introduced };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('retained-only safety: path helpers never escape the repository root', () => {
  const root = makeRepo({ 'src/parser.mjs': parser });
  try {
    eq(core.toRepoRelative(root, join(root, 'src/parser.mjs')), 'src/parser.mjs', 'inside');
    eq(core.toRepoRelative(root, join(root, '..', 'outside.ts')), null, 'outside');
    eq(core.toRepoRelative(root, 'src/parser.mjs'), 'src/parser.mjs', 'relative input');
    eq(core.toRepoRelative(root, 'src\\parser.mjs'), 'src/parser.mjs', 'windows separators');
    eq(core.toRepoRelative(root, ''), null, 'empty input');
    return { ok: true };
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('defect 1 (R1): analyzeFsMutation reads through the single normalized repository path', () => {
  const asked = [];
  const current = { exists: true, content: 'export function existing(v) {\n  return v;\n}\n' };
  const reader = (p) => { asked.push(p); return current; };
  const bodyRewrite = 'export function existing(v) {\n  return String(v);\n}\n';
  // Absolute caller input with the normalized override: the reader must see
  // ONLY the repository-relative representation, never the raw absolute path.
  const viaAbsolute = core.analyzeFsMutation({
    toolName: 'write',
    args: { file_path: 'C:\\repo\\src\\util.js', content: bodyRewrite },
    rel: 'src/util.js',
  }, reader);
  eq(asked.length, 1, 'exactly one read');
  eq(asked[0], 'src/util.js', 'the reader receives the normalized repository path');
  eq(viaAbsolute.introduced.length, 0, 'a body-only rewrite of an existing declaration introduces nothing');
  eq(viaAbsolute.paths.join(','), 'src/util.js', 'reports use the same normalized representation');
  // The relative form of the same file produces the identical decision.
  const viaRelative = core.analyzeFsMutation({ toolName: 'write', args: { file_path: 'src/util.js', content: bodyRewrite }, rel: 'src/util.js' }, reader);
  eq(JSON.stringify(viaRelative.introduced), JSON.stringify(viaAbsolute.introduced), 'absolute and relative inputs decide identically');
  // Genuinely new declarations are still detected, and the legacy no-override
  // contract (relative raw path) is unchanged.
  const fresh = core.analyzeFsMutation({ toolName: 'edit', args: { file_path: 'src/a.js', old_string: 'return v;', new_string: 'return v;\nfunction added() {}' } }, reader);
  eq(fresh.introduced.map((s) => s.name).join(','), 'added', 'a new declaration is still introduced');
  eq(asked[asked.length - 1], 'src/a.js', 'legacy relative contract intact');
  return { reads: asked, absoluteIntroduced: viaAbsolute.introduced.length, newDeclarationDetected: true };
});

check('defect 2 (R1): evidence persistence verifies bytes and digest and fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'addy-dg-evidence-'));
  try {
    const record = { task: 'unit', kind: 'preflight', file: 'src/x.mjs', at: '2026-10-11T00:00:00.000Z' };
    const persisted = core.persistEvidenceRecord({ dir, record });
    ok(persisted.verified === true && persisted.bytes > 0 && existsSync(persisted.path), 'the success path returns a verified reference');
    eq(readFileSync(persisted.path, 'utf8'), JSON.stringify(record, null, 2), 'the stored format is the unchanged evidence format');
    // A record without `task` (acknowledgment) persists under its kind label —
    // the old code threw on `record.task.replace` and silently lost the file.
    const ack = core.persistEvidenceRecord({ dir, record: { kind: 'acknowledge', file: 'src/x.mjs' } });
    ok(/acknowledge-[0-9a-f]{12}\.json$/.test(ack.path.replace(/\\/g, '/')), `acknowledgment evidence must persist under its kind label: ${ack.path}`);
    // A write failure propagates instead of returning a success-shaped value.
    let threw = null;
    try { core.persistEvidenceRecord({ dir, record: { task: 'w' }, io: { write: () => { throw new Error('EACCES: simulated'); } } }); } catch (error) { threw = error; }
    ok(threw !== null && /EACCES: simulated/.test(threw.message), `a write failure must propagate with its cause: ${threw?.message}`);
    // A corrupted read-back is detected and the corrupt file is removed so a retry cannot collide.
    const unlinked = [];
    threw = null;
    try {
      core.persistEvidenceRecord({ dir, record: { task: 'corrupt' }, io: { read: () => Buffer.from('{ corrupted'), unlink: (p) => { unlinked.push(p); } } });
    } catch (error) { threw = error; }
    ok(threw !== null && /evidence verification failed/.test(threw.message), `a digest mismatch must throw: ${threw?.message}`);
    eq(unlinked.length, 1, 'the corrupt record must be removed');
    // A byte-length mismatch alone is also detected.
    threw = null;
    try { core.persistEvidenceRecord({ dir, record: { task: 'short' }, io: { read: (p) => readFileSync(p).subarray(0, 5), unlink: () => {} } }); } catch (error) { threw = error; }
    ok(threw !== null && /evidence verification failed/.test(threw.message), 'a truncated read-back must throw');
    return { verified: persisted.verified, ackLabel: ack.path.split(/[\\/]/).pop(), writeFailure: 'propagated', mismatch: 'detected+unlinked', truncated: 'detected' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --------------------------------------------------------------- benchmark */

console.log('\nScale benchmark (repository scan = preflight cost)');
{
  const root = mkdtempSync(join(tmpdir(), 'addy-dg-bench-'));
  const dirs = 40;
  const perDir = 25;
  const names = [];
  let bytes = 0;
  for (let d = 0; d < dirs; d++) {
    const dir = join(root, `packages/pkg${String(d).padStart(2, '0')}/src`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < perDir; f++) {
      let body = '';
      for (let k = 0; k < 25; k++) {
        body += `export function helper${d}_${f}_${k}(value) {\n  return value + ${k};\n}\n\nexport const CONST${d}_${f}_${k} = ${k};\n\n`;
        names.push(`helper${d}_${f}_${k}`);
      }
      writeFileSync(join(dir, `module${f}.ts`), body);
      bytes += body.length;
    }
  }
  const fileCount = dirs * perDir;
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    core.scanRepository({ root, names: [`brandNewHelper${i}`] });
    timings.push(performance.now() - started);
  }
  const missing = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const scan = core.scanRepository({ root, names: [`helper7_3_${i}`] });
    missing.push(scan.declarations[`helper7_3_${i}`].length);
    timings.push(performance.now() - started);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const first = core.scanRepository({ root, names: ['helper3_7_4'] });
  evidence.benchmark = {
    files: fileCount, approximateBytes: bytes,
    p50Ms: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    exactHits: missing,
    indexedDeclarations: first.indexSize,
    similarForExistingName: (first.similar['helper3_7_4'] ?? []).slice(0, 3),
  };
  ok(missing.every((n) => n === 1), `an existing declaration must be found exactly once: ${JSON.stringify(missing)}`);
  ok(evidence.benchmark.indexedDeclarations >= 20000, `the declaration index must cover the synthetic repository, got ${evidence.benchmark.indexedDeclarations}`);
  ok(evidence.benchmark.p50Ms < 5000, `scan must stay bounded, got ${evidence.benchmark.p50Ms} ms`);
  console.log(`  ${fileCount} files / ~${(bytes / 1048576).toFixed(1)} MiB: p50 ${evidence.benchmark.p50Ms} ms, max ${evidence.benchmark.maxMs} ms, ${evidence.benchmark.indexedDeclarations} declarations indexed`);
  rmSync(root, { recursive: true, force: true });
}

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'addy-dg-unit-'));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'guard@example.test');
  git('config', 'user.name', 'Duplicate Guard Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return root;
}

evidence.pass = failures === 0 && evidence.cases.every((c) => c.pass);
writeFileSync(new URL('../evidence/duplicate-guard-unit.json', import.meta.url), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.pass ? 'ALL CASES PASS' : `${failures} FAILURE(S)`} — ${evidence.cases.length} cases; evidence/duplicate-guard-unit.json`);
if (!evidence.pass) process.exitCode = 1;
