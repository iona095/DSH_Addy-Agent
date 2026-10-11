import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {commandNames,loadCommand,skills,organize,buildMode,constraintsMode,verifyIntegrity,hash,runSpecialists} from '../core.mjs';
test('pinned 212 upstream files retain exact byte digests',()=>assert.equal(verifyIntegrity().filesVerified,212));
test('9 command definitions keep source and verbatim arguments',()=>{
 for(const name of commandNames) {
  const a=loadCommand(name,'  auto && unsafe input $ARGUMENTS\n');
  const b=loadCommand(name,a.arguments);
  assert.equal(a.source,readFileSync(a.path,'utf8'));
  assert.equal(a.sha256,hash(a.source));assert.deepEqual(a,b);
  assert.ok(a.instructions.includes(a.source));assert.equal(a.arguments,'  auto && unsafe input $ARGUMENTS\n');
 }
 assert.throws(()=>loadCommand('unknown'));
});
test('25 skills have exact original bodies and resource directories',()=>{
 const all=skills();assert.equal(all.length,25);assert.equal(new Set(all.map(x=>x.name)).size,25);
 for(const item of all) {assert.equal(item.content,readFileSync(item.path,'utf8'));assert.equal(item.resourceBase.kind,'directory');}
});
test('build modes and constraint subcommands are not fuzzy-autonomous',()=>{
 assert.equal(buildMode(''),'single-task');assert.equal(buildMode('auto'),'autonomous');assert.equal(buildMode('all'),'autonomous');
 assert.equal(buildMode('automatic please'),'single-task');
 for(const x of ['check','guard','ratchet']) assert.equal(constraintsMode(x),x);
 assert.equal(constraintsMode(''),'setup');
});
test('processor retains duplicate side effect executions and disagreements',()=>{
 const value=organize({command:'ship',operations:[{task:'write',result:{ok:true}},{task:'write',result:{ok:true}},{task:'test',error:'failed'}],
  reports:[{persona:'code-reviewer',status:'completed',childId:'a'},{persona:'security-auditor',status:'failed',error:'startup failure'}],
  findings:[{file:'a.js',line:1,text:'unsafe',severity:'Critical',agent:'a'},{file:'a.js',line:1,text:'unsafe',severity:'Critical',agent:'b'},{file:'a.js',line:1,text:'unsafe',severity:'Optional',agent:'c'}]});
 assert.equal(value.operations.length,3);assert.equal(value.counts.toolCalls,3);assert.equal(value.counts.uniqueResults,2);assert.equal(value.counts.duplicateResults,1);
 assert.equal(value.groupedFindings.length,2);assert.equal(value.groupedFindings[0].provenance.length,2);
 assert.equal(value.rawFindings.length,3);assert.equal(value.errors.length,2);assert.equal(value.incomplete,true);assert.equal(value.subagents.completed,1);
 assert.equal('verdict' in value,false);assert.equal('tokenSavings' in value,false);
});
test('per-branch persona and cleanup failures preserve sibling outputs',async()=>{
 const service={async startActivation(){return {childId:'cleanup-fixture',result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:'Complete independent report retained despite disposal error'}]}),async dispose(){throw new Error('intentional cleanup failure');}};}};
 const reports=await runSpecialists({service,parent:{id:'unit-parent'},signal:new AbortController().signal,personas:['unknown-persona','code-reviewer'],context:'Unit failure projection fixture only'});
 assert.equal(reports.length,2);assert.equal(reports[0].status,'failed');assert.match(reports[0].error.message,/Unknown persona/);assert.equal(reports[0].personaSha256,null);
 assert.equal(reports[1].status,'incomplete');assert.match(reports[1].cleanupError.message,/intentional cleanup failure/);assert.equal(reports[1].output[0].text,'Complete independent report retained despite disposal error');
 const full=organize({command:'ship',reports});assert.equal(full.incomplete,true);assert.equal(full.errors.length,2);
});
