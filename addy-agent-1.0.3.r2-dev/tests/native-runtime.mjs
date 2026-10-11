import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {runSpecialists,upstream,specialistDeny,organize,concise,hash} from '../core.mjs';
// Isolate original project/user override precedence from this machine's existing personas.
// This changes only this test process environment; never writes the user's profile.
process.env.USERPROFILE=new URL('.',import.meta.url).pathname.replace(/^\//,'');
const installed='C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg=async name=>import(pathToFileURL(join(installed,name,'lib/index.js')));
const {Context}=await pkg('cordis');
const ctx=new Context();
const mount=async(name,config={})=>{const mod=await pkg(name);ctx.plugin(mod.default??mod,config);return mod;};
await mount('dsh-session-projection');await mount('dsh-session');await mount('dsh-agent');await mount('dsh-system-prompt');await mount('dsh-tools');
const llm=await mount('dsh-llm');await mount('dsh-fs-local');await mount('dsh-working-directory',{defaultDirectory:process.cwd()});await mount('dsh-agent-loop');await mount('dsh-subagent');await mount('dsh-subagent-spawn-in-process');
await new Promise(resolve=>setImmediate(resolve));
const evidence={runtimeVersion:JSON.parse(readFileSync(join(installed,'dsh-agent-loop/package.json'),'utf8')).version,transport:'deterministic test-only LlmAdapter; NOT real configured provider',nativeServices:['Cordis Context','AgentLoop','SubagentRuntime','SpawnInProcessProvider','Tools'],cases:[]};
evidence.rawSessionEvents=[];
ctx.on('session/event',(session,event)=>{evidence.rawSessionEvents.push({sessionId:session.id,event});});
let state;
class FixtureAdapter extends llm.LlmAdapter {
 async *stream(options){try{
  const system=options.messages.filter(m=>m.role==='system').map(m=>m.content.map(b=>b.text??'').join('')).join('\n');
  const persona=state.personas.find(p=>system.includes(readFileSync(join(upstream,'agents',`${p}.md`),'utf8')));
  assert.ok(persona,'exact persona bytes present in native model request');
  const visible=(options.tools??[]).map(t=>t.name);
  assert.ok(visible.includes('native_probe'),'allowed tool remains callable');
  for(const denied of specialistDeny) assert.ok(!visible.includes(denied),`${denied} removed from child schemas`);
  const entry={persona,childId:options.sessionId,enteredAt:Date.now(),exactPersona:true,personaSha256:hash(readFileSync(join(upstream,'agents',`${persona}.md`),'utf8')),visibleTools:visible};
  const child=ctx.agents.get(options.sessionId);assert.ok(child,'real native child Agent registered');
  entry.deniedExecutions=[];
  for(const name of ['subagent','workflow']){
   let denied;try { denied=await child.ctx.tools.execute({name,callId:`deny-${persona}-${name}`,arguments:{},agent:child,signal:options.signal}); } catch(error) { denied={isError:true,error:{name:error.name,message:error.message,code:error.code??null}}; }
   assert.equal(denied.isError,true,'restriction rejects direct nested delegation execution');entry.deniedExecutions.push({name,outcome:denied});
  }
  state.entries.push(entry);
  if(state.entries.length===3){state.allEnteredAt=Date.now();state.release();}
  await state.barrier;
  options.signal?.throwIfAborted();
  entry.releasedAt=Date.now();
  if(state.failure===persona) throw new llm.LlmError('intentional native fixture provider failure','NATIVE_TEST_FAILURE');
  yield {type:'block-start',index:0,blockType:'text'};
  yield {type:'text-delta',index:0,text:`Independent ${persona} report; deterministic transport fixture, no code review claim.`};
  yield {type:'block-end',index:0,block:{type:'text',text:`Independent ${persona} report; deterministic transport fixture, no code review claim.`}};
  yield {type:'finish',reason:{kind:'stop'}};
 }catch(e){if(e.code!=='NATIVE_TEST_FAILURE')console.error('FIXTURE ERROR',e);throw e;}}

}
ctx.llm.registerAdapter(['native-fixture'],new FixtureAdapter());
for(const name of [...specialistDeny,'native_probe']) ctx.tools.register({name,description:'Native restriction test sentinel',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:()=>[{type:'text',text:'probe'}]},isConcurrencySafe:()=>true,async execute(){return {ok:true};}});
const parent=await ctx.agentLoop.create('native-addy-parent',{provider:'native-fixture',model:'deterministic'},{cwd:process.cwd()});
try{
 for(const failure of [null,'security-auditor']){
  let release;const barrier=new Promise(r=>release=r);
  state={personas:['code-reviewer','security-auditor','test-engineer'],entries:[],barrier,release,failure};
  const reports=await Promise.race([runSpecialists({service:ctx.subagents,parent,signal:new AbortController().signal,personas:state.personas,context:'Native concurrency fixture context; do not inspect or change project files.'}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Three-child stream barrier timed out')),15000);t.unref();})]);
  if(state.entries.length!==3) console.error(JSON.stringify(reports,null,2));
  assert.equal(state.entries.length,3);assert.equal(new Set(state.entries.map(e=>e.childId)).size,3);
  assert.ok(state.entries.every(e=>e.releasedAt>=state.allEnteredAt),'all three real child streams entered before ANY was released');
  const full=organize({command:'ship',reports});
  assert.equal(full.subagents.started,3);assert.equal(full.subagents.completed,failure?2:3);assert.equal(full.subagents.failed,failure?1:0);
  assert.equal(full.incomplete,Boolean(failure));
  evidence.cases.push({case:failure?'one-provider-failure':'success',entries:state.entries,allEnteredAt:state.allEnteredAt,reports,organized:full,concise:concise(full,{path:new URL('../evidence/native-runtime.json',import.meta.url).pathname,pointer:`/cases/${evidence.cases.length}/organized`,sha256:hash(JSON.stringify(full)),bytes:Buffer.byteLength(JSON.stringify(full))})});
 }
 evidence.pass=true;
}finally{await ctx.fiber.dispose();writeFileSync(new URL('../evidence/native-runtime.json',import.meta.url),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({pass:evidence.pass,cases:evidence.cases.map(c=>({case:c.case,subagents:c.organized.subagents}))},null,2));
