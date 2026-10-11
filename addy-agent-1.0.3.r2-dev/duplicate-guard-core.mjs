/**
 * addy-duplicate-guard — policy core.
 *
 * Pure, dependency-free (node: builtins only) decision logic for the
 * SEARCH-FIRST / REUSE-FIRST policy. `duplicate-guard.mjs` (the Cordis plugin)
 * only adapts DSH tool executions into the inputs this module consumes, so
 * every rule below is unit-testable without a live host.
 *
 * Deliberate limitations are documented in DUPLICATE-GUARD.md; the symbol
 * extractor is a line-oriented heuristic, not a parser.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, relative, sep, extname, isAbsolute, join } from 'node:path';

/* ------------------------------------------------------------------ paths */

/** Extensions treated as production source code. */
export const PRODUCTION_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'rb', 'php',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx',
  'scala', 'dart', 'lua', 'pl', 'pm', 'ex', 'exs', 'vue', 'svelte', 'astro',
]);

/** Path segments that never hold reviewed production source. */
export const EXEMPT_SEGMENTS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'output',
  'coverage', 'vendor', 'target', 'bin', 'obj', '.next', '.nuxt', '.output',
  '.cache', '.parcel-cache', '__pycache__', '.venv', 'venv', 'site-packages',
  '.idea', '.vscode', 'tmp', '.tmp', '.gradle', 'Pods', 'DerivedData',
  '.terraform', '.serverless', '.yarn', '.pnpm-store',
]);

/** Path segments that mark test/spec/fixture trees (TDD is never gated). */
export const TEST_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures',
  'testdata', 'snapshots', '__snapshots__', '__mocks__', 'cypress', 'playwright',
]);

/** True for a basename that is a test/spec/declaration/generated artifact. */
export function isExemptBasename(base) {
  const lower = base.toLowerCase();
  if (/\.d\.(ts|mts|cts)$/.test(lower)) return true;
  if (/\.(test|spec|bench|benchmark|stories|story|config|generated|gen|min|snap)\.[^.]+$/.test(lower)) return true;
  if (/^test_/.test(lower)) return true;
  if (/_test\.[^.]+$/.test(lower)) return true;
  if (lower === 'conftest.py' || lower === 'setup.py' || lower === 'vite.config.ts') return true;
  return false;
}

/**
 * Repo-relative POSIX path for `p`, or null when outside `root`.
 * @param {string} root absolute repository root
 * @param {string} p absolute or root-relative path
 */
export function toRepoRelative(root, p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Classify one repo-relative path.
 * @returns {{production: boolean, reason: string}}
 */
export function classifyPath(rel, config = {}) {
  if (typeof rel !== 'string' || rel.length === 0) return { production: false, reason: 'empty-path' };
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return { production: false, reason: 'outside-repository' };
  const segments = rel.split('/');
  for (const extra of config.exemptPaths ?? []) {
    const needle = String(extra).replace(/\\/g, '/').replace(/\/+$/, '');
    if (needle && (rel === needle || rel.startsWith(`${needle}/`))) return { production: false, reason: `configured-exempt:${needle}` };
  }
  if (segments.some((s) => s.startsWith('.'))) return { production: false, reason: 'hidden-path' };
  for (const s of segments) if (EXEMPT_SEGMENTS.has(s)) return { production: false, reason: `non-source-segment:${s}` };
  for (const s of segments) if (TEST_SEGMENTS.has(s)) return { production: false, reason: `test-segment:${s}` };
  const base = segments[segments.length - 1];
  const ext = extname(base).slice(1).toLowerCase();
  if (!PRODUCTION_EXT.has(ext)) return { production: false, reason: `non-source-extension:${ext || '(none)'}` };
  if (isExemptBasename(base)) return { production: false, reason: 'exempt-basename' };
  if (config.productionPaths?.length) {
    const hit = config.productionPaths.some((p) => {
      const needle = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
      return rel === needle || rel.startsWith(`${needle}/`);
    });
    if (!hit) return { production: false, reason: 'outside-configured-production-paths' };
  }
  return { production: true, reason: 'production-source' };
}

/** Convenience predicate over {@link classifyPath}. */
export const isProductionSource = (rel, config = {}) => classifyPath(rel, config).production;

/* ------------------------------------------------------- symbol extraction */

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else',
  'new', 'typeof', 'await', 'case', 'throw', 'delete', 'void', 'in', 'of',
  'with', 'yield', 'super', 'this', 'try', 'finally', 'class', 'import',
  'export', 'const', 'let', 'var', 'default', 'extends', 'implements',
  'instanceof', 'debugger', 'break', 'continue', 'interface', 'type', 'enum',
]);

const COMMENT_PAIRS = [
  { open: '/*', close: '*/' },
  { open: '"""', close: '"""' },
  { open: "'''", close: "'''" },
];

/**
 * Strip line comments, block comments and string literals from one line while
 * carrying block state across lines. Heuristic: enough to keep declaration
 * regexes from firing inside comments and string bodies.
 * @returns {[string, boolean]} cleaned line and the new in-block state
 */
function stripLine(line, inBlock, hashComments) {
  // Fast path: a line with no comment or quote character cannot hide either.
  if (!inBlock && (hashComments ? !/['"`#/]/.test(line) : !/['"`/]/.test(line))) return [line, false];
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      const pair = COMMENT_PAIRS.find((p) => p.close === inBlock);
      const end = line.indexOf(pair.close, i);
      if (end === -1) return [out, inBlock];
      i = end + pair.close.length;
      inBlock = false;
      continue;
    }
    const rest = line.slice(i);
    const opener = COMMENT_PAIRS.find((p) => rest.startsWith(p.open));
    if (opener) {
      inBlock = opener.close;
      i += opener.open.length;
      continue;
    }
    if (rest.startsWith('//') || (hashComments && rest.startsWith('#'))) break;
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === ch) break;
        j += 1;
      }
      out += ch + ch; // keep a shape marker, drop the payload
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return [out, inBlock];
}

const RX = {
  jsFunction: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  jsAssigned: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\()/,
  jsAsyncArrow: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\s+[A-Za-z_$][\w$.]*\s*=>/,
  jsModified: /^\s*(?:public|private|protected|static|async|readonly|abstract|override|declare)\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\(/,
  jsMethod: /^\s*([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::[^;{}]*)?\{/,
  pyDef: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  pyClass: /^\s*class\s+([A-Za-z_]\w*)/,
  goFunc: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  rsFn: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+)?(?:fn)\s+([A-Za-z_]\w*)/,
  ktFun: /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|private|protected|internal|open|final|abstract|override|suspend|inline|infix|operator|tailrec|external|expect|actual|const|lateinit|vararg|noinline|crossinline|reified|fun\s)+\s*(?:<[^>]*>\s*)?([A-Za-z_]\w*)\s*\(/,
  swiftFunc: /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|private|internal|fileprivate|open|static|class|final|override|mutating|nonmutating|convenience|required|dynamic|\s)*func\s+([A-Za-z_]\w*)/,
  rbDef: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
  phpFunc: /^\s*(?:public|private|protected|static|final|abstract|\s)*function\s+&?\s*([A-Za-z_]\w*)/,
  modMember: /^\s*(?:public|private|protected|internal|static|final|virtual|override|abstract|synchronized|native|sealed|async|unsafe|new|extern|partial|readonly|volatile)\b[^;=(){}]*?\s([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws[^;{}]*)?(?:where[^;{}]*)?\{/,
  cMember: /^\s*(?:static\s+|inline\s+|extern\s+|constexpr\s+|virtual\s+|explicit\s+|friend\s+|template\s*<[^>]*>\s*)*[\w:<>,\*&\s]+?\s([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept[^;{}]*)?(?:override\s*)?(?:final\s*)?(?:->\s*[^;{}]+)?\{/,
};

const LANG_OF_EXT = {  ts: 'js', tsx: 'js', mts: 'js', cts: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', pyi: 'py',
  go: 'go', rs: 'rs', kt: 'kt', kts: 'kt', swift: 'swift',
  rb: 'rb', php: 'php',
  java: 'mod', cs: 'mod', scala: 'mod', dart: 'mod', groovy: 'mod', vb: 'mod',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c',
  lua: 'lua', pl: 'pl', pm: 'pl', ex: 'ex', exs: 'ex',
};

/** Cheap pre-filter: a declaration line always carries `=`/`(` or a keyword. */
const QUICK_DECL = /[=(]|\b(?:function|def|func|fn|fun|class)\b/;

/**
 * Extract named function-like declarations from source text.
 * Line-oriented heuristic; the same input always yields the same output.
 * @param {string} text
 * @param {string} rel repo-relative path used for language selection
 * @returns {Array<{name: string, kind: string, line: number}>}
 */
export function extractSymbols(text, rel = '') {
  const ext = extname(rel).slice(1).toLowerCase();
  const lang = LANG_OF_EXT[ext] ?? 'js';
  const lines = String(text).split(/\r?\n/);
  const found = [];
  const seen = new Set();
  let inBlock = false;
  const hashComments = lang === 'py' || lang === 'rb' || lang === 'pl' || lang === 'ex';
  for (let index = 0; index < lines.length; index++) {
    const [clean, next] = stripLine(lines[index], inBlock, hashComments);
    inBlock = next;
    if (!QUICK_DECL.test(clean)) continue;
    const push = (name, kind) => {
      if (!name) return;
      if (lang === 'js' && JS_KEYWORDS.has(name)) return;
      if (lang === 'mod' || lang === 'c') {
        if (JS_KEYWORDS.has(name) || ['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'else', 'do'].includes(name)) return;
      }
      const key = `${name}@${index + 1}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ name, kind, line: index + 1 });
    };
    switch (lang) {
      case 'js': {
        let m = RX.jsFunction.exec(clean); if (m) { push(m[1], 'function'); break; }
        m = RX.jsAssigned.exec(clean); if (m) { push(m[1], 'function'); break; }
        m = RX.jsAsyncArrow.exec(clean); if (m) { push(m[1], 'function'); break; }
        m = RX.jsModified.exec(clean); if (m) { push(m[1], 'method'); break; }
        m = RX.jsMethod.exec(clean); if (m) { push(m[1], 'method'); break; }
        break;
      }
      case 'py': {
        let m = RX.pyDef.exec(clean); if (m) { push(m[1], 'function'); break; }
        m = RX.pyClass.exec(clean); if (m) { push(m[1], 'class'); break; }
        break;
      }
      case 'go': { const m = RX.goFunc.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'rs': { const m = RX.rsFn.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'kt': { const m = RX.ktFun.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'swift': { const m = RX.swiftFunc.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'rb': { const m = RX.rbDef.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'php': { const m = RX.phpFunc.exec(clean); if (m) push(m[1], 'function'); break; }
      case 'mod': { const m = RX.modMember.exec(clean); if (m) push(m[1], 'method'); break; }
      case 'c': {
        if (/;\s*$/.test(clean)) break;
        const m = RX.cMember.exec(clean); if (m) push(m[1], 'function');
        break;
      }
      default: break;
    }
  }
  return found;
}

/** Declaration names present in `text`, as a Set. */
export const declaredNames = (text, rel) => new Set(extractSymbols(text, rel).map((s) => s.name));

/**
 * Names declared in `after` that were not declared in `before`.
 * @returns {Array<{name: string, kind: string, line: number}>}
 */
export function introducedSymbols(before, after, rel) {
  const prior = declaredNames(before ?? '', rel);
  const out = [];
  const seen = new Set();
  for (const symbol of extractSymbols(after ?? '', rel)) {
    if (prior.has(symbol.name) || seen.has(symbol.name)) continue;
    seen.add(symbol.name);
    out.push(symbol);
  }
  return out;
}

/* ------------------------------------------------------- mutation analysis */

/**
 * Build the virtual post-mutation content for one fs-tool call so introduced
 * symbols can be computed exactly for `edit` and `write`.
 * @param {{toolName: string, args: any}} call
 * @param {(rel: string) => {exists: boolean, content: string}} readCurrent
 * @returns {{paths: string[], introduced: Array, requiresAnalysis: boolean, note: string|null}}
 */
export function analyzeFsMutation(call, readCurrent, config = {}) {
  const args = call?.args ?? {};
  const rawPath = args.file_path ?? args.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { paths: [], introduced: [], requiresAnalysis: false, note: 'no-file-path' };
  }
  // Single normalized representation: the caller resolves the raw (possibly
  // absolute) path against the repository root EXACTLY once and passes the
  // result as `call.rel`. Every read and report below uses only that value, so
  // relative and absolute inputs for the same file produce identical
  // decisions. Without the override the raw path is only slash-normalized
  // (legacy contract for direct core callers with repository-relative input).
  const rel = call.rel !== undefined ? String(call.rel) : rawPath.replace(/\\/g, '/');
  if (rel.length === 0) {
    return { paths: [], introduced: [], requiresAnalysis: false, note: 'no-file-path' };
  }
  const current = readCurrent(rel);
  const relForLang = rel;
  if (call.toolName === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    return {
      paths: [rel],
      introduced: introducedSymbols(current.content ?? '', content, relForLang),
      requiresAnalysis: true,
      note: current.exists ? null : 'new-file',
    };
  }
  if (call.toolName === 'edit') {
    const oldString = typeof args.old_string === 'string' ? args.old_string : '';
    const newString = typeof args.new_string === 'string' ? args.new_string : '';
    let virtual;
    let note = null;
    if (oldString.length === 0) {
      virtual = `${current.content ?? ''}\n${newString}`;
      note = 'empty-old-string';
    } else if ((current.content ?? '').includes(oldString)) {
      virtual = current.content.replace(oldString, newString);
    } else {
      // Cannot reconstruct the exact post-state; the fs tool will reject this
      // edit anyway (stale read). Analyse the added text conservatively.
      virtual = `${current.content ?? ''}\n${newString}`;
      note = 'old-string-not-found';
    }
    return { paths: [rel], introduced: introducedSymbols(current.content ?? '', virtual, relForLang), requiresAnalysis: true, note };
  }
  return { paths: [rel], introduced: [], requiresAnalysis: false, note: 'unsupported-tool' };
}

/* ------------------------------------------------------------ repo scanning */

const DEFAULT_SCAN = { maxFiles: 4000, maxBytes: 24 * 1024 * 1024, maxFileBytes: 512 * 1024, maxRefsPerName: 25, maxIndex: 40000 };

/** Iterative repository walk that skips VCS, dependency and build trees. */
export function* walkSourceFiles(root, config = {}) {
  const skip = new Set([...EXEMPT_SEGMENTS, '.git']);
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = readdirSync(relDir ? join(root, relDir) : root, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isProductionSource(rel, config)) continue;
      yield rel;
    }
  }
}

/**
 * Scan every production source file once, building a declaration index plus
 * exact-name declaration/reference hits and token-similarity candidates.
 * Bounded; `truncated` reports any cut so callers never overclaim coverage.
 */
export function scanRepository({ root, names = [], config = {} } = {}) {
  const limits = { ...DEFAULT_SCAN, ...(config.scan ?? {}) };
  const wanted = [...new Set(names.filter((n) => typeof n === 'string' && n.length > 0))];
  // R2-fix: null-prototype symbol indexes. Plain objects inherit constructor/toString/valueOf,
  // so prototype names misfire as hits and .push throws. Own-key checks below treat every
  // name (including __proto__/hasOwnProperty) as ordinary data.
  const declarations = Object.create(null);
  const references = Object.create(null);
  const similar = Object.create(null);
  for (const n of wanted) {
    declarations[n] = [];
    references[n] = [];
    similar[n] = [];
  }
  const wantedTokens = new Map(wanted.map((n) => [n, new Set(symbolTokens(n))]));
  // Cheap pre-filter: only symbol names sharing a leading or trailing fragment
  // with the query are worth a full token comparison. Keeps the per-file pass
  // linear instead of running Jaccard against every declaration in the tree.
  const similarKeys = wanted.map((n) => [n, n.slice(0, 4).toLowerCase(), n.slice(-4).toLowerCase()]);
  const index = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let truncated = false;
  let truncatedReason = null;
  const startedAt = Date.now();
  for (const rel of walkSourceFiles(root, config)) {
    if (filesScanned >= limits.maxFiles) { truncated = true; truncatedReason = 'max-files'; break; }
    if (bytesScanned >= limits.maxBytes) { truncated = true; truncatedReason = 'max-bytes'; break; }
    let text;
    try {
      const stat = statSync(join(root, rel));
      if (stat.size > limits.maxFileBytes) { truncated = true; truncatedReason ??= 'max-file-bytes'; continue; }
      text = readFileSync(join(root, rel), 'utf8');
    } catch { continue; }
    filesScanned += 1;
    bytesScanned += text.length;
    const lines = text.split(/\r?\n/);
    for (const symbol of extractSymbols(text, rel)) {
      if (index.length < limits.maxIndex) index.push({ name: symbol.name, kind: symbol.kind, path: rel, line: symbol.line });
      if (Object.hasOwn(declarations, symbol.name)) declarations[symbol.name].push({ path: rel, line: symbol.line, kind: symbol.kind });
      if (similarKeys.length > 0 && (!Object.hasOwn(declarations, symbol.name) || !Object.hasOwn(similar, symbol.name))) {
        const lower = symbol.name.toLowerCase();
        for (const [name, head, tail] of similarKeys) {
          if (symbol.name === name) continue;
          if (similar[name].length >= 10) continue;
          if (!lower.includes(head) && !lower.includes(tail)) continue;
          const score = tokenSimilarity(wantedTokens.get(name), symbolTokens(symbol.name));
          if (score >= 0.5) similar[name].push({ name: symbol.name, path: rel, line: symbol.line, score: Number(score.toFixed(3)) });
        }
      }
    }
    for (const name of wanted) {
      if (references[name].length >= limits.maxRefsPerName) continue;
      // Substring pre-filter: a per-line regex sweep only when the file can
      // possibly contain the name at all.
      if (!text.includes(name)) continue;
      const rx = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}([^\\w$]|$)`, '');
      for (let i = 0; i < lines.length; i++) {
        if (references[name].length >= limits.maxRefsPerName) break;
        if (rx.test(lines[i])) references[name].push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
      }
    }
  }
  for (const name of wanted) {
    declarations[name].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    references[name].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    similar[name].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  }
  return { root, filesScanned, bytesScanned, truncated, truncatedReason, durationMs: Date.now() - startedAt, declarations, references, similar, indexSize: index.length };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** camelCase/snake_case/kebab token set of a symbol name. */
export function symbolTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Jaccard similarity of two symbol names' token sets. */
export function tokenSimilarity(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/* --------------------------------------------------------- shell / PTC text */

const SHELL_WRITE = [
  { id: 'redirect', rx: /(^|[^>\\])>(?!>)/ },
  { id: 'append', rx: />>/ },
  { id: 'tee', rx: /(^|[|;&]\s*)tee\b/i },
  { id: 'set-content', rx: /\bSet-Content\b/i },
  { id: 'add-content', rx: /\bAdd-Content\b/i },
  { id: 'out-file', rx: /\bOut-File\b/i },
  { id: 'new-item', rx: /\bNew-Item\b/i },
  { id: 'copy-item', rx: /\bCopy-Item\b/i },
  { id: 'move-item', rx: /\bMove-Item\b/i },
  { id: 'remove-item', rx: /\bRemove-Item\b/i },
  { id: 'sed-inplace', rx: /\bsed\s+-[a-zA-Z]*i/ },
  { id: 'perl-inplace', rx: /\bperl\s+-[a-zA-Z]*i/ },
  { id: 'truncate', rx: /\btruncate\b/ },
  { id: 'dd-of', rx: /\bdd\s+[^\n|]*\bof=/ },
  { id: 'git-apply', rx: /\bgit\s+apply\b/ },
  { id: 'patch', rx: /\bpatch\s+-p\d*/ },
  { id: 'write-file', rx: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\b/ },
  { id: 'cp', rx: /(^|[|;&]\s*)cp\s+[^\n|;&]+/ },
  { id: 'mv', rx: /(^|[|;&]\s*)mv\s+[^\n|;&]+/ },
];

/** Write constructs whose target is not visible in the command text itself. */
const OPAQUE_TARGET_WRITES = new Set(['git-apply', 'patch', 'sed-inplace', 'perl-inplace', 'truncate']);

/** Constructs that hide a program body inside the command text. */
const SHELL_OPAQUE = [
  { id: 'heredoc', rx: /<<-?\s*['"]?[A-Za-z_]\w*['"]?/ },
  { id: 'pwsh-command', rx: /\b(?:pwsh|powershell)\b[^\n]*\s-(?:c|Command|EncodedCommand)\b/i },
  { id: 'bash-command', rx: /\b(?:bash|sh|zsh)\b[^\n]*\s-c\b/ },
  { id: 'node-eval', rx: /\bnode\b[^\n]*\s(?:-e|--eval)\b/ },
  { id: 'python-eval', rx: /\bpython[\w.]*\b[^\n]*\s-c\b/ },
  { id: 'perl-eval', rx: /\bperl\b[^\n]*\s-e\b/ },
  { id: 'ruby-eval', rx: /\bruby\b[^\n]*\s-e\b/ },
  { id: 'deno-eval', rx: /\bdeno\b[^\n]*\beval\b/ },
];

const FUNC_DECL_TEXT = /\b(?:function\s+[A-Za-z_$][\w$]*|def\s+[A-Za-z_]\w*\s*\(|func\s+[A-Za-z_]\w*\s*\(|fn\s+[A-Za-z_]\w*\s*\(|fun\s+[A-Za-z_]\w*\s*\(|[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\())|=>\s*\{/;

/** Declaration-shaped name patterns usable directly on raw command/program text. */
const DECL_TEXT_PATTERNS = [
  /(?:^|[^\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /(?:^|[^\w$.])(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g,
  /(?:^|[^\w$.])func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g,
  /(?:^|[^\w$.])(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/g,
  /(?:^|[^\w$.])fun\s+([A-Za-z_]\w*)\s*\(/g,
  /(?:^|[^\w$.])function\s+&?\s*([A-Za-z_]\w*)\s*\(/g,
  /(?:^|[^\w$.])(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\()/g,
];

/**
 * Names of function-shaped declarations visible in arbitrary text — including
 * inside string literals, which is where a shell command or a PTC program
 * carries the source it is about to write. Heuristic and order-stable.
 * @returns {string[]} unique names in first-appearance order
 */
export function declaredNamesInText(text) {
  const source = String(text ?? '');
  const out = [];
  const seen = new Set();
  for (const pattern of DECL_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Git verbs that can move a ref (and therefore invalidate revision-bound evidence). */
const GIT_REF_VERBS = /\bgit\b[^\n|;&]*\b(?:commit|merge|rebase|reset|checkout|switch|cherry-pick|revert|pull|push|stash|am|apply|update-ref|update-index|tag|branch|gc|filter-branch)\b/;

/** Whether a shell command can move HEAD or refs and must invalidate cached revision facts. */
export const refMutatingGit = (command) => GIT_REF_VERBS.test(String(command ?? ''));

/**
 * Find production-source path tokens in arbitrary text (command or program).
 * @returns {string[]} normalized, de-duplicated, repository-relative-ish paths
 */
export function productionPathTokens(text) {
  const out = new Set();
  const rx = /(?:[A-Za-z]:)?[A-Za-z0-9_.@\-/\\]+\.(?:[A-Za-z]{1,4})/g;
  for (const match of String(text).matchAll(rx)) {
    const token = match[0];
    const ext = extname(token).slice(1).toLowerCase();
    if (!PRODUCTION_EXT.has(ext)) continue;
    const normalized = token.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isExemptBasename(normalized.split('/').pop())) continue;
    out.add(normalized);
  }
  return [...out];
}

/**
 * Decide whether one shell command is a production source mutation that the
 * policy must gate, and whether it is a git boundary operation.
 */
export function analyzeShellCommand(command, config = {}) {
  const text = String(command ?? '');
  const writes = SHELL_WRITE.filter((w) => w.rx.test(text)).map((w) => w.id);
  const opaque = SHELL_OPAQUE.filter((o) => o.rx.test(text)).map((o) => o.id);
  const paths = productionPathTokens(text).filter((p) => isProductionSource(p, config));
  const declaresFunction = FUNC_DECL_TEXT.test(text);
  const gitCommit = /(^|[^-\w])git\b[^\n|;&]*\bcommit\b/.test(text) && !/--dry-run/.test(text);
  const gitPush = /(^|[^-\w])git\b[^\n|;&]*\bpush\b/.test(text);
  const writeClose = dataWriteClose(text);
  const mutating = writes.length > 0 || opaque.length > 0 || writeClose;
  const declaredNames = declaredNamesInText(text);
  // Patch-applying and in-place editors name no target in their own text, so a
  // visible path is not required before they are gated.
  const opaqueTarget = writes.some((w) => OPAQUE_TARGET_WRITES.has(w));
  const gated = (writes.length > 0 && (paths.length > 0 || declaresFunction))
    || (opaque.length > 0 && paths.length > 0 && (declaresFunction || writes.length > 0 || writeClose))
    || (writeClose && paths.length > 0)
    || opaqueTarget;
  return { mutating, gated, writes, opaque, paths, declaresFunction, declaredNames, writeClose, gitCommit, gitPush, reasons: [...writes, ...opaque] };
}

/** PowerShell/.NET inline write forms (`[IO.File]::WriteAllText`, `open(...,'w')`). */
function dataWriteClose(text) {
  return /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|Create)\b/i.test(text)
    || /\bopen\s*\([^)]*,\s*['"][wa]/.test(text)
    || /\bwith\s+open\s*\([^)]*,\s*['"][wa]/.test(text)
    || /::new\s*\(\s*[^)]*\)\s*\.Write/.test(text);
}

const PTC_WRITE_PRIMITIVES = [
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream',
  'rmSync', 'rmdirSync', 'unlinkSync', 'unlink', 'renameSync', 'rename',
  'copyFileSync', 'copyFile', 'mkdirSync', 'mkdir', 'truncateSync', 'truncate',
  'chmodSync', 'utimesSync',
];
const PTC_PROCESS_PRIMITIVES = ['child_process', 'spawnSync', 'execSync', 'execFileSync', 'spawn(', 'exec('];
const PTC_MODULE_LOAD = /(?:import\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]|from\s*['"](?:node:)?fs(?:\/promises)?['"]|require\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]|(?:node:)?child_process)/;

/**
 * Inspect one `run_code` program for a *direct* filesystem/process mutation of
 * production source paths — the path that bypasses the tool bindings.
 */
export function analyzeRunCode(code, config = {}) {
  const text = String(code ?? '');
  const moduleLoad = PTC_MODULE_LOAD.test(text);
  const writePrimitives = PTC_WRITE_PRIMITIVES.filter((p) => new RegExp(`\\b${escapeRegExp(p)}\\b`).test(text));
  const processPrimitives = PTC_PROCESS_PRIMITIVES.filter((p) => text.includes(p));
  const paths = productionPathTokens(text).filter((p) => isProductionSource(p, config));
  const declaresFunction = FUNC_DECL_TEXT.test(text);
  // A visible production path token is required: a program that merely runs
  // `git log` or reads sources stays untouched. Computed paths remain a
  // documented residual closed by the git-boundary check.
  const mutating = writePrimitives.length > 0 || processPrimitives.length > 0;
  const gated = mutating && paths.length > 0;
  const declaredNames = declaredNamesInText(text);
  return { moduleLoad, writePrimitives, processPrimitives, paths, declaresFunction, declaredNames, mutating, gated };
}

/* --------------------------------------------------------------- git edges */

/** Read-only git helper. Never mutates; returns null on any failure. */
export function git(root, args, exec = execFileSync) {
  try {
    return exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch { return null; }
}

/** Repository root for `dir` (falling back to `dir` itself outside a repo). */
export function repositoryRoot(dir, exec = execFileSync) {
  const top = git(dir, ['rev-parse', '--show-toplevel'], exec);
  return top && top.length > 0 ? resolve(top) : resolve(dir);
}

/** Current HEAD commit, or null outside a repository / unborn branch. */
export const gitHead = (root, exec = execFileSync) => git(root, ['rev-parse', 'HEAD'], exec);

/**
 * Worktree-relative production files that differ from HEAD, split by whether
 * git already tracks them. One `git status` process.
 * @returns {{tracked: string[], untracked: string[]}|null} null outside a repository
 */
export function gitChangedFiles(root, config = {}, exec = execFileSync) {
  const raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], exec);
  if (raw === null) return null;
  const tracked = [];
  const untracked = [];
  for (const entry of raw.split('\0').filter(Boolean)) {
    const status = entry.slice(0, 2);
    let rel = entry.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const parts = rel.split('\0');
      rel = parts[parts.length - 1];
    }
    if (status.includes('D')) continue;
    if (!isProductionSource(rel, config)) continue;
    (status === '??' ? untracked : tracked).push(rel);
  }
  return { tracked: [...new Set(tracked)], untracked: [...new Set(untracked)] };
}

/** File content at `rev`, or '' when the path does not exist there. */
export function gitFileAt(root, rev, rel, exec = execFileSync) {
  const value = git(root, ['show', `${rev}:${rel}`], exec);
  return value ?? '';
}

/**
 * Git-boundary validation: every production function newly declared relative
 * to HEAD must sit inside an approved edit scope for the current revision.
 *
 * Detection is a single `git diff -U0 HEAD` pass over added lines plus a direct
 * read of each untracked file, so the cost stays constant in the number of
 * changed files, and a *moved* declaration is not mistaken for a new one.
 * @returns {{checked: number, introduced: Array, outsideScope: Array}}
 */
export function gitBoundaryIntroduced({ root, head, isPathApproved, config = {}, exec = execFileSync }) {
  const status = gitChangedFiles(root, config, exec);
  if (status === null) return { checked: 0, introduced: [], outsideScope: [], notARepository: true };
  const introduced = [];
  const seen = new Set();
  const push = (rel, name, kind, line) => {
    const key = `${name}@${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    const record = { path: rel, name, kind, line: line ?? null };
    introduced.push(record);
  };
  if (status.tracked.length > 0) {
    const diff = git(root, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff', '--'], exec) ?? '';
    let current = null;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('+++ ')) {
        const target = line.slice(4).trim();
        current = target === '/dev/null' ? null : target.replace(/^b\//, '');
        continue;
      }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      if (current === null || !isProductionSource(current, config)) continue;
      for (const name of declaredNamesInText(line.slice(1))) push(current, name, 'function');
    }
  }
  for (const rel of status.untracked) {
    let text;
    try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const symbol of extractSymbols(text, rel)) push(rel, symbol.name, symbol.kind, symbol.line);
  }
  const outsideScope = introduced.filter((item) => !isPathApproved(item.path));
  return { checked: status.tracked.length + status.untracked.length, introduced, outsideScope };
}

/* ------------------------------------------------------------ scope helpers */

/**
 * Persist one decision record durably and VERIFY the stored result.
 *
 * Fail-closed contract: this function either returns the verified
 * `{path, sha256, bytes, verified: true}` reference or throws with the
 * original cause — a caller must never treat a failed persistence as an
 * accepted decision. Verification is a read-back: the stored byte length and
 * SHA-256 must equal the serialized record exactly. A record that fails
 * verification is removed best-effort so a later retry (always a fresh
 * hash-addressed file) cannot collide with corrupt residue. The serialized
 * format is unchanged (`JSON.stringify(record, null, 2)`); the filename label
 * falls back from `task` to `kind` so records without a task (acknowledgments)
 * persist instead of failing on an undefined field. `io` is injectable for
 * regression tests; the default is the real filesystem.
 */
export function persistEvidenceRecord({ dir, record, io = {} }) {
  const read = io.read ?? ((path) => readFileSync(path));
  const write = io.write ?? ((path, text) => writeFileSync(path, text, { flag: 'wx' }));
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
  const unlink = io.unlink ?? ((path) => unlinkSync(path));
  const text = JSON.stringify(record, null, 2);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const bytes = Buffer.byteLength(text);
  const label = String(record.task ?? record.kind ?? 'record').replace(/[^\w.-]+/g, '_').slice(0, 40);
  mkdir(dir);
  const path = resolve(dir, `${label}-${sha256.slice(0, 12)}.json`);
  write(path, text);
  const stored = read(path);
  const storedBytes = Buffer.byteLength(stored);
  const storedSha256 = createHash('sha256').update(stored).digest('hex');
  if (storedBytes !== bytes || storedSha256 !== sha256) {
    try { unlink(path); } catch { /* best-effort cleanup; a retry writes a fresh hash-addressed file */ }
    throw new Error(`evidence verification failed for ${path}: stored ${storedBytes} bytes / sha256 ${storedSha256}, expected ${bytes} bytes / sha256 ${sha256}`);
  }
  return { path, sha256, bytes, verified: true };
}

/** Normalize one configured edit-scope entry to a repo-relative posix prefix. */
export function normalizeScopeEntry(entry) {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return null;
  if (trimmed.split('/').includes('..')) return null;
  return trimmed;
}

/** Whether `rel` lies inside any normalized scope prefix. */
export function pathInScope(rel, scope) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  return (scope ?? []).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}
