import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {commandNames,verifyIntegrity,hash,skills} from '../core.mjs';

const require=createRequire('C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json');
const {parse}=require('yaml');
const patchText=readFileSync(new URL('../cordis.patch.yml',import.meta.url),'utf8');
const evidence={testedAt:new Date().toISOString(),nodeVersion:process.version,cases:[],limitations:['Configuration shape inspection only; services and dispatch covered independently in contracts-runtime.mjs and duplicate-guard-runtime.mjs.']};
const check=(name,fn)=>{try{evidence.cases.push({name,pass:true,detail:fn()});}catch(e){evidence.cases.push({name,pass:false,error:{name:e.name,message:e.message}});}};

/** Every plugin row the Addy preset declared before the duplicate guard existed. */
const PRESET_ROWS_BEFORE_GUARD=['persona','agent-instructions','time-context','tool-bash','tool-pwsh','tool-fs','tool-fs-search','tool-jobs','tool-schedule','skill-filesystem','tool-skill','command-goal','tool-goal','compaction','delegation','tool-ask-user','tool-todo','tool-web','tool-presentation','present','tool-plugin-manager','addy-compatibility'];

check('patch inserts only the isolated addy-agent preset',()=>{const patch=parse(patchText);assert.equal(patch.length,1);assert.deepEqual(Object.keys(patch[0]),['insert']);assert.equal(patch[0].insert.length,1);const preset=patch[0].insert[0];assert.equal(preset.name,'@deepseek-ai/dsh-agent-preset');assert.equal(preset.config.id,'addy-agent');const entries=preset.config.plugins;assert.equal(entries.find(x=>x.id==='tool-presentation').config.mode,'ptc');assert.equal(entries.find(x=>x.id==='addy-compatibility').name,'@local/dsh-addy-agent');const workflow=entries.find(x=>x.id==='delegation').config.find(x=>x.id==='workflow-ptc');assert.equal(workflow.config.maxConcurrentAgents,3);return {patchSha256:hash(patchText),presetId:preset.config.id,pluginCount:entries.length,workflow};});

check('the duplicate guard is the ONLY row added to the preset and every pre-existing row is unchanged',()=>{
  const preset=parse(patchText)[0].insert[0];
  const entries=preset.config.plugins;
  const after=entries.map(x=>x.id);
  const guard=entries.find(x=>x.id==='addy-duplicate-guard');
  assert.ok(guard,'the guard row must be mounted in the preset');
  assert.equal(guard.name,'@local/dsh-addy-agent/duplicate-guard');
  assert.deepEqual(after.filter(id=>id!=='addy-duplicate-guard'),PRESET_ROWS_BEFORE_GUARD,'row order and identity of every pre-existing plugin must be untouched');
  assert.equal(after[after.length-1],'addy-duplicate-guard','the guard is appended last, so it cannot reorder another row');
  return {rows:after.length,added:['addy-duplicate-guard'],preexisting:PRESET_ROWS_BEFORE_GUARD.length};
});

check('the guard module is loadable through the package subpath the row names',async()=>{
  const url=require.resolve('@local/dsh-addy-agent/duplicate-guard',{paths:['C:/Users/GNV/.dsh/profiles/web']});
  const mod=await import(pathToFileURL(url).href);
  assert.equal(mod.name,'addy-duplicate-guard');
  assert.deepEqual(mod.inject,['tools','systemPrompt']);
  assert.equal(typeof mod.apply,'function');
  return {resolved:url,plugin:mod.name,inject:mod.inject};
});

check('pinned manifest integrity, nine commands and twenty-five skills are unchanged',()=>{
  assert.equal(commandNames.length,9);
  assert.deepEqual(commandNames,['spec','plan','build','test','constraints','review','webperf','code-simplify','ship']);
  const all=skills();
  assert.equal(all.length,25);
  const integrity=verifyIntegrity();
  assert.equal(integrity.filesVerified,212);
  return {revision:integrity.revision,filesVerified:integrity.filesVerified,commands:commandNames.length,skills:all.length};
});

evidence.pass=evidence.cases.every(x=>x.pass);
writeFileSync(new URL('../evidence/contracts-config.json',import.meta.url),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));if(!evidence.pass)process.exitCode=1;
