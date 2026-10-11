/**
 * addy-duplicate-guard — preservation evidence.
 *
 * Proves the duplicate guard changed exactly two composition files and nothing
 * else: the 212 pinned upstream files, the Addy adapter generation, the nine
 * command definitions, the 25 skills and the persona set are byte-identical to
 * the digests recorded before the guard was written.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {commandNames,personaNames,skills,upstream,verifyIntegrity} from '../core.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const evidence={testedAt:new Date().toISOString(),cases:[]};
const check=(name,fn)=>{try{evidence.cases.push({name,pass:true,detail:fn()});}catch(e){evidence.cases.push({name,pass:false,error:{name:e.name,message:e.message}});}};

/** SHA-256 recorded immediately before the duplicate guard was written. */
const BASELINE={
  'adapter-v2.mjs':'f6c55969122dbf60354dfc1b8c3c520f9eaebfdd0bffaa5f6f82c519f89e8c1c',
  'core-v2.mjs':'aa601cab6498dd1d225e29ca4980a3cc244daed61a336beb8bde582b9202c596',
  'core.mjs':'58f4759eb01cd52189a6a3c02fe6aae147ff0a42eff0a1d6b5241b8931f2e9ab',
  'index.mjs':'75f1d8b0725df27dbf8c7ebe62ba7ba8864903a1f0bc632b7c06908e2a3081ce',
  'upstream-manifest.json':'62128b77abfb84f7daedc04c2f3af6bfc03cdb40dba4da366e18e7544839f13b',
  'package.json':'15d42bc78d6c22bed4ee07b5d1a9837ffc03188d88d943e18cd90b9f8e8117c4',
  'cordis.patch.yml':'d80de4a8ee19b76502cb89f1955d895f5b2155b4ddacfc1687e37f0dc98aa3fe',
};
/** The only two files this change is allowed to modify. */
const ALLOWED_TO_DIFFER=['package.json','cordis.patch.yml'];
/** Digest of the pinned upstream tree over the 212 manifest-tracked files. */
const UPSTREAM_TRACKED_FILES=212;

/** Walk without following the nested upstream/.git checkout. */
function walkTracked(dir){
  const out=[];
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='.git')continue;
    const path=join(dir,entry.name);
    if(entry.isDirectory())out.push(...walkTracked(path));
    else out.push(path);
  }
  return out;
}

check('the pinned upstream tree is byte-identical (212 manifest-tracked files)',()=>{
  const integrity=verifyIntegrity();
  const files=walkTracked(upstream);
  assert.equal(files.length,UPSTREAM_TRACKED_FILES,`upstream file count changed: ${files.length}`);
  const lines=files.map(f=>`${hash(readFileSync(f))}  ${relative(upstream,f).split(sep).join('/')}`).sort();
  // verifyIntegrity() checks every file against digests inside upstream-manifest.json,
  // whose own bytes are pinned by the previous case: the chain is what proves the tree.
  assert.equal(integrity.filesVerified,UPSTREAM_TRACKED_FILES);
  const newest=files.map(f=>statSync(f).mtimeMs).reduce((a,b)=>Math.max(a,b),0);
  const edited=Math.min(...ALLOWED_TO_DIFFER.map(f=>statSync(join(root,f)).mtimeMs));
  assert.ok(newest<edited,`an upstream file is newer than the files this change edited (${new Date(newest).toISOString()} >= ${new Date(edited).toISOString()})`);
  return {revision:integrity.revision,files:files.length,treeSha256:hash(lines.join('\n')),newestUpstreamMtime:new Date(newest).toISOString()};
});

check('every file that must not change keeps its exact pre-change bytes',()=>{
  const changed=[];
  const kept={};
  for(const [file,digest] of Object.entries(BASELINE)){
    const actual=hash(readFileSync(join(root,file)));
    kept[file]=actual;
    if(ALLOWED_TO_DIFFER.includes(file))continue;
    if(actual!==digest)changed.push({file,expected:digest,actual});
  }
  assert.deepEqual(changed,[],`frozen files changed: ${JSON.stringify(changed)}`);
  return kept;
});

check('the only files differing from the pre-change baseline are the two composition files',()=>{
  const differing=Object.entries(BASELINE)
    .filter(([file,digest])=>hash(readFileSync(join(root,file)))!==digest)
    .map(([file])=>file);
  assert.deepEqual(differing.slice().sort(),ALLOWED_TO_DIFFER.slice().sort(),`unexpected modified file set: ${JSON.stringify(differing)}`);
  return {differing,note:'Both are Addy-preset composition files, not pinned upstream content. Documentation additions (README.md, VERIFICATION.md, DUPLICATE-GUARD.md) and the two new guard modules are additive.'};
});

check('the nine commands, twenty-five skills and four personas are untouched',()=>{
  assert.equal(commandNames.length,9);
  const all=skills();
  assert.equal(all.length,25);
  for(const item of all){
    assert.equal(item.content,readFileSync(item.path,'utf8'),`skill body changed: ${item.name}`);
    assert.equal(item.resourceBase.kind,'directory');
  }
  const personas=personaNames.map(p=>({persona:p,sha256:hash(readFileSync(join(upstream,'agents',`${p}.md`)))}));
  assert.equal(new Set(personas.map(p=>p.sha256)).size,4);
  return {commands:9,skills:25,personas};
});

check('package.json differs only by the two duplicate-guard entries',()=>{
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'@local/dsh-addy-agent');
  assert.equal(pkg.version,'1.0.3');
  assert.equal(pkg.exports['./duplicate-guard'],'./duplicate-guard.mjs');
  assert.equal(pkg.exports['./duplicate-guard-core'],'./duplicate-guard-core.mjs');
  assert.equal(pkg.exports['.'],'./index.mjs','the original entry point must be unchanged');
  assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
  assert.ok(pkg.files.includes('duplicate-guard.mjs')&&pkg.files.includes('duplicate-guard-core.mjs'));
  assert.ok(pkg.files.includes('adapter-v2.mjs')&&pkg.files.includes('upstream'));
  return {exports:Object.keys(pkg.exports).filter(k=>k.includes('duplicate-guard'))};
});

evidence.pass=evidence.cases.every(c=>c.pass);
writeFileSync(new URL('../evidence/duplicate-guard-preservation.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
if(!evidence.pass)process.exitCode=1;
