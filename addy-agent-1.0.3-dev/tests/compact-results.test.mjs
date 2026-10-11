import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply} from '../adapter-v2.mjs';
import {organize, concise, saveEvidence, hash, revision} from '../core.mjs';

const personas = ['code-reviewer', 'security-auditor', 'test-engineer'];
const markers = personas.map((p,i) => `FULL-REPORT-${p}-${i}-` + 'X'.repeat(8_192));

function checkEvidence(ref, expected) {
  const savedText = readFileSync(ref.path, 'utf8');
  assert.equal(ref.sha256, hash(savedText), 'full evidence hash must match its bytes');
  assert.equal(ref.bytes, Buffer.byteLength(savedText), 'full evidence size must match');
  assert.equal(savedText, JSON.stringify(expected,null,2), 'full evidence must preserve original JSON bytes');
}

test('concise() removes both full-report copies while preserving attributed pointers and unaltered evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'addy-compact-'));
  try {
    const reports = personas.map((persona, i) => ({persona, status:'completed', childId:`child-${i}`, source:`source-${i}`, output:[{type:'text',text:markers[i]}]}));
    const operations = [{task:'write',result:{ok:true}}, {task:'write',result:{ok:true}}, {task:'check',error:'intentional-test-error'}];
    const findings = [
      {file:'one.js',text:'unsafe',severity:'Critical',agent:'code-reviewer'},
      {file:'one.js',text:'unsafe',severity:'Critical',agent:'security-auditor'},
      {file:'one.js',text:'unsafe',severity:'Important',agent:'test-engineer'}
    ];
    const full = organize({command:'ship',reports,operations,findings});
    const reference = saveEvidence(dir,full);
    const compact = concise(full,reference);
    checkEvidence(reference,full);
    assert.equal('reports' in compact, false);
    assert.equal('operations' in compact, false);
    assert.equal('rawFindings' in compact, false);
    assert.deepEqual(compact.groups.byAgent,{
      'code-reviewer':['/reports/0'],
      'security-auditor':['/reports/1'],
      'test-engineer':['/reports/2']
    });
    assert.deepEqual(compact.specialistReports.map(r=>r.fullResultPointer),['/reports/0','/reports/1','/reports/2']);
    assert.equal(compact.counts.toolCalls,3);
    assert.equal(compact.counts.duplicateResults,1);
    assert.equal(compact.counts.duplicateFindings,1);
    assert.equal(compact.groups.bySeverity.Critical.length,1);
    const compactText=JSON.stringify(compact);
    for(const marker of markers) assert.equal(compactText.includes(marker),false,'raw report leaked into concise projection');
    const originalProjectionBytes=Buffer.byteLength(JSON.stringify({...compact,groups:full.groups,reports}));
    const compactBytes=Buffer.byteLength(compactText);
    assert.ok(compactBytes < originalProjectionBytes / 4,`expected >=75% reduction; got ${compactBytes}/${originalProjectionBytes}`);
    for(let i=0;i<3;i++) assert.equal(JSON.parse(readFileSync(reference.path,'utf8')).reports[i].output[0].text,markers[i]);
  } finally {
    rmSync(dir,{recursive:true,force:true});
  }
});

test('the actual adapter tool responses are compact and evidence allows full /ship report retrieval', async () => {
  const registrations=new Map();
  const started=[];
  const ctx={
    skills:{register(){return ()=>{};}},
    systemPrompt:{section(){return ()=>{};}},
    tools:{register(tool){registrations.set(tool.name,tool);return ()=>{};}},
    workingDirectory:{async ensure(){return tmpdir();}},
    subagents:{async startActivation(request){
      const i=started.length;
      started.push(request);
      return {childId:`child-${i}`,result:Promise.resolve({stopReason:'completed',output:[{type:'text',text:markers[i]}]}),async dispose(){}};
    }},
    effect(fn){return fn();},
    on(){return ()=>{};}
  };
  apply(ctx);
  const agent={id:'fixture-parent',session:{header:{parentSession:null}}};
  const exec={agent,signal:new AbortController().signal};
  const saved=[];
  try {
    const command=await registrations.get('addy_command').execute({command:'ship',arguments:''},exec);
    assert.equal(command.revision,revision);
    const specialists=await registrations.get('addy_specialists').execute({personas,context:'Independent fixture reviewers must write complete reports'},exec);
    saved.push(specialists.fullResult.path);
    assert.equal(started.length,3);
    assert.equal(specialists.subagents.completed,3);
    assert.equal('reports' in specialists,false,'adapter must not reinsert raw reports');
    assert.equal('output' in specialists.specialistReports[0],false);
    assert.deepEqual(specialists.groups.byAgent['code-reviewer'],['/reports/0']);
    for(const marker of markers) assert.equal(JSON.stringify(specialists).includes(marker),false);
    const full=JSON.parse(readFileSync(specialists.fullResult.path,'utf8'));
    checkEvidence(specialists.fullResult,full);
    for(let i=0;i<3;i++) assert.equal(full.reports[i].output[0].text,markers[i],`missing full report ${i}`);
    const finalResults=await registrations.get('addy_results').execute({findings:[]},exec);
    saved.push(finalResults.fullResult.path);
    assert.equal('reports' in finalResults,false);
    for(const marker of markers) assert.equal(JSON.stringify(finalResults).includes(marker),false,'raw report leaked into addy_results');
    const finalFull=JSON.parse(readFileSync(finalResults.fullResult.path,'utf8'));
    checkEvidence(finalResults.fullResult,finalFull);
    for(let i=0;i<3;i++) assert.equal(finalFull.reports[i].output[0].text,markers[i]);
    const fullReportsProjection=Buffer.byteLength(JSON.stringify({...specialists,reports:full.reports,groups:full.groups}));
    const compactBytes=Buffer.byteLength(JSON.stringify(specialists));
    assert.ok(compactBytes < fullReportsProjection / 4,`specialist response insufficiently compact: ${compactBytes}/${fullReportsProjection}`);
  } finally {
    for(const path of saved) unlinkSync(path);
  }
});
