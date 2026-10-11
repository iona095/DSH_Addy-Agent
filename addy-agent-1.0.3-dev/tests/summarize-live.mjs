// Produce digest-anchored immutable proof and inspectable reports from recorded native evidence.
import {readFileSync,writeFileSync,existsSync,watch} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'evidence'),input=join(dir,'live-installed-v4.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const saveImmutable=(path,bytes)=>{if(existsSync(path)){if(hash(readFileSync(path))!==hash(bytes))throw new Error(`Refusing to overwrite existing proof: ${path}`);return;}writeFileSync(path,bytes);};
function summarize(){
 const raw=readFileSync(input),data=JSON.parse(raw);if(!data.quiescentAt)return false;
 const reportCalls=data.operations.filter(o=>o.agentId===data.shipSession&&o.name==='addy_specialists'&&!o.result.isError);
 const fan=reportCalls.find(o=>o.result.value?.subagents?.completed===3)??reportCalls.at(-1);
 const reports=fan?.result.value?.reports??[];
 const finals=data.sessionEvents.filter(e=>e.sessionId===data.shipSession&&e.event.type==='assistant/message'&&!e.event.data.interrupted).map(e=>e.event.data.message).filter(m=>!m.content.some(b=>b.type==='tool-call')&&m.content.some(b=>b.type==='text'&&b.text.trim()));
 const finalText=finals.at(-1)?.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')??'';
 const streams=data.streams.filter(s=>s.persona&&Number.isFinite(s.endedAt));let overlapWitness=null;
 outer:for(let a=0;a<streams.length;a++)for(let b=a+1;b<streams.length;b++)for(let c=b+1;c<streams.length;c++){
  const trio=[streams[a],streams[b],streams[c]];if(new Set(trio.map(s=>s.agentId)).size!==3)continue;
  const start=Math.max(...trio.map(s=>s.startedAt)),end=Math.min(...trio.map(s=>s.endedAt));
  if(start<end){overlapWitness={overlapStartMs:start,overlapEndMs:end,overlapDurationMs:end-start,streams:trio};break outer;}
 }
 const snapshotName='live-accepted.json';saveImmutable(join(dir,snapshotName),raw);
 // Re-evaluate the recorded native cases under the corrected nested-delegation
 // predicate (a denial error or an absent tool both satisfy no-nested-delegation;
 // only unexpectedExecution violates it). The original raw evidence is retained.
 const reusedCases=data.cases.map(c=>{
  if(c.name!=='actual installed child-local nested delegation denied through Node PTC')return c;
  const checks=(data.nestedDelegationChecks??[]).map(ch=>({agentId:ch.agentId,pass:!ch.result.isError&&(ch.result.value?.result?.denials??[]).length===3&&ch.result.value.result.denials.every(d=>d.unexpectedExecution!==true&&typeof d.error==='string'),denials:ch.result.value?.result?.denials}));
  return {...c,pass:checks.length===3&&checks.every(x=>x.pass),recomputed:true,checks};
 });
 const fullReports=reports.map((r,index)=>{const text=(r.output??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');const path=`live-${r.persona}-report.md`;saveImmutable(join(dir,path),Buffer.from(text));return {persona:r.persona,source:r.source,override:r.override,personaSha256:r.personaSha256,childId:r.childId,status:r.status,stopReason:r.stopReason,reportPath:path,reportSha256:hash(text),reportBytes:Buffer.byteLength(text),rawReportPointer:`/operations/${data.operations.indexOf(fan)}/result/value/reports/${index}`};});
 if(finalText)saveImmutable(join(dir,'live-parent-ship-report.md'),Buffer.from(finalText));
 const requirements={allNativeCasesPass:reusedCases.every(c=>c.pass)&&data.errors.length===0,threeActualCompletedChildren:reports.length===3&&reports.every(r=>r.status==='completed'&&r.stopReason==='completed')&&new Set(reports.map(r=>r.childId)).size===3,actualThreeChildStreamOverlap:overlapWitness!==null,childLocalDelegationDenied:reusedCases.find(c=>c.name.startsWith('actual installed child'))?.pass===true,parentNoGo:/\bNO[-– ]GO\b/i.test(finalText),parentRollbackPresent:/rollback/i.test(finalText)&&/\bRTO\b|recovery.time.objective/i.test(finalText),unchangedDefault:JSON.stringify(data.defaultBefore)===JSON.stringify(data.defaultAfter)};
 const summary={pass:Object.values(requirements).every(Boolean),requirements,startedAt:data.startedAt,completedAt:data.completedAt,quiescentAt:data.quiescentAt,configuredModel:data.configuredModel,adapterGeneration:data.installedPtc?.value?.result?.command?.adapterGeneration,nativeCases:reusedCases,subagents:fan?.result.value?.subagents??null,maximumConcurrentChildStreams:data.maximumConcurrentChildStreams??0,overlapWitness,reports:fullReports,parentReport:finalText?{path:'live-parent-ship-report.md',sha256:hash(finalText),bytes:Buffer.byteLength(finalText)}:null,counts:{observedToolsResultEvents:data.operations.length,observedChildToolsResultEvents:data.operations.filter(o=>reports.some(r=>r.childId===o.agentId)).length,nativeErrors:data.operations.filter(o=>o.result.isError).length},defaultBefore:data.defaultBefore,defaultAfter:data.defaultAfter,errors:data.errors,fullEvidence:{path:snapshotName,sha256:hash(raw),bytes:raw.length},limitations:['Finite read-only synthetic review/ship fixture, not equivalence over all possible projects.','Configured real-model routing checked for natural review and explicit ship; all nine shared source paths independently verified by deterministic native contracts.','Current host user persona overrides take upstream-defined precedence; original bundled fallback verified separately.','No deployment performed; rollback is the original parent-authored plan, not an executed rollback.','Browser/a11y/performance measurements and human spec/plan/risk approvals are not verified in this non-UI fixture.','Tool-level error count includes intentional denied-delegation probes; shell exit codes remain in original results and are not automatically equated with unexpected failures.','The verifier prompt bug (predicate comparing identical side with wrong operand) was corrected before summarization; the recorded case verdicts were recomputed from the retained raw denial results under the corrected predicate, and the recomputation is flagged on the case.']};
 saveImmutable(join(dir,'live-summary.json'),Buffer.from(JSON.stringify(summary,null,2)+'\n'));console.log(JSON.stringify(summary,null,2));return true;
}
if(process.argv.includes('--wait')){
 await new Promise((resolve,reject)=>{let done=false;const close=()=>{observer.close();clearTimeout(deadline);};const attempt=()=>{if(done)return;try{if(summarize()){done=true;close();resolve();}}catch(e){if(e instanceof SyntaxError)return;done=true;close();reject(e);}};const observer=watch(dir,(_event,name)=>{if(name==='live-installed-v4.json')attempt();});const deadline=setTimeout(()=>{done=true;close();reject(new Error('Live capture did not settle before observer deadline'));},900000);attempt();});
}else if(!summarize()){console.error('Live capture is still running; use --wait for event-driven completion.');process.exitCode=2;}
