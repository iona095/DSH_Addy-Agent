import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import * as core from '../duplicate-guard-core.mjs';
import { generation } from '../duplicate-guard.mjs';
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS ' + name);
  } catch (e) {
    failures += 1;
    console.log('  FAIL ' + name + ' ' + e.message);
  }
}
const ok = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || 'mismatch') + ': expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dg-r2-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}
function writeSrc(root, p, c) { writeFileSync(join(root, p), c); }
function clean(root) { rmSync(root, { recursive: true, force: true }); }
const CTOR = 'export class Widget {\n  constructor(value) {\n    this.value = value;\n  }\n}\n';
const METHODS = 'export class Thing {\n  toString() {\n    return "t";\n  }\n  valueOf() {\n    return 1;\n  }\n}\n';
const YAMLSRC = 'export class YamlDoc {\n  constructor(t) {\n    this.t = t;\n  }\n}\nexport function renderYaml(d) {\n  return String(d.t);\n}\n';
const EXIST = 'export function parseConfig(t) {\n  return t.trim();\n}\n';
check('R2-1 ctor unrelated', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/ctor.mjs', CTOR);
    const s = core.scanRepository({ root, names: ['unrelatedFunction'] });
    eq(s.declarations.unrelatedFunction.length, 0, 'clean');
    eq(s.filesScanned, 1, 'one file');
  } finally { clean(root); }
});
check('R2-2 methods unrelated', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/methods.mjs', METHODS);
    const s = core.scanRepository({ root, names: ['unrelatedOther'] });
    eq(s.declarations.unrelatedOther.length, 0, 'clean');
  } finally { clean(root); }
});
check('R2-3 explicit ctor', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/ctor.mjs', CTOR);
    const s = core.scanRepository({ root, names: ['constructor'] });
    ok(s.declarations.constructor.length >= 1, 'found');
    eq(s.declarations.constructor[0].path, 'src/ctor.mjs', 'path');
  } finally { clean(root); }
});
check('R2-4 proto keys safe', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/normal.mjs', 'export function normalFunc() {\n  return 1;\n}\n');
    const s = core.scanRepository({ root, names: ['__proto__'] });
    eq(s.declarations['__proto__'].length, 0, 'proto clean');
    const t = core.scanRepository({ root, names: ['hasOwnProperty'] });
    eq(t.declarations.hasOwnProperty.length, 0, 'hasOwn clean');
    ok(Object.hasOwn(s.declarations, '__proto__'), 'own proto key');
  } finally { clean(root); }
});
check('R2-5 missing never inherited', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/ctor.mjs', CTOR);
    const s = core.scanRepository({ root, names: ['missingNope'] });
    eq(s.declarations.missingNope.length, 0, 'missing empty');
    eq(typeof s.declarations.toString, 'undefined', 'no inherited toString');
    eq(Object.hasOwn(s.declarations, 'toString'), false, 'no own toString');
    eq(Object.hasOwn(s.declarations, 'constructor'), false, 'no own ctor');
  } finally { clean(root); }
});
check('R2-6 recheck proto names', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/ctor.mjs', CTOR);
    const introduced = ['toString', 'myFunc'];
    const declared = new Set(['myFunc']);
    const undeclared = introduced.filter((n) => !declared.has(n));
    eq(undeclared.join(','), 'toString', 'undeclared');
    const scan = core.scanRepository({ root, names: undeclared });
    let m = Object.create(null);
    m = scan.declarations;
    for (const n of introduced) {
      if (!Object.hasOwn(m, n)) m[n] = [];
    }
    for (const n of introduced) {
      const bucket = Object.hasOwn(m, n) ? m[n] : [];
      ok(Array.isArray(bucket), 'bucket array for ' + n);
    }
  } finally { clean(root); }
});
check('R2-7 duplicate still blocks', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/existing.mjs', EXIST);
    const s = core.scanRepository({ root, names: ['parseConfig'] });
    eq(s.declarations.parseConfig.length, 1, 'duplicate found');
    eq(s.declarations.parseConfig[0].path, 'src/existing.mjs', 'dup path');
  } finally { clean(root); }
});
check('R2-8 clean new permits', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/existing.mjs', EXIST);
    const s = core.scanRepository({ root, names: ['brandNewFunc'] });
    eq(s.declarations.brandNewFunc.length, 0, 'clean');
    eq(s.references.brandNewFunc.length, 0, 'no refs');
  } finally { clean(root); }
});
check('R2-9 yaml renderer fixture', () => {
  const root = makeRoot();
  try {
    writeSrc(root, 'src/yaml-renderer.mjs', YAMLSRC);
    const cleanScan = core.scanRepository({ root, names: ['renderYamlStrict'] });
    eq(cleanScan.declarations.renderYamlStrict.length, 0, 'new yaml helper clean');
    const existScan = core.scanRepository({ root, names: ['renderYaml'] });
    eq(existScan.declarations.renderYaml.length, 1, 'existing yaml found');
    const unrelated = core.scanRepository({ root, names: ['unrelatedYaml'] });
    eq(unrelated.declarations.unrelatedYaml.length, 0, 'ctor does not crash yaml scan');
  } finally { clean(root); }
});
check('R2-10 generation r2 and guard source', () => {
  eq(generation, 'r2', 'generation marker');
  const src = readFileSync(new URL('../duplicate-guard.mjs', import.meta.url), 'utf8');
  ok(src.includes('Object.create(null)'), 'guard uses null-proto');
  ok(src.includes('Object.hasOwn'), 'guard uses hasOwn');
  const coreSrc = readFileSync(new URL('../duplicate-guard-core.mjs', import.meta.url), 'utf8');
  ok(coreSrc.includes('Object.create(null)'), 'core uses null-proto');
  ok(coreSrc.includes('Object.hasOwn'), 'core uses hasOwn');
});
if (failures > 0) {
  console.log(failures + ' FAILURE(S)');
  process.exitCode = 1;
} else {
  console.log('ALL R2 CASES PASS');
}



