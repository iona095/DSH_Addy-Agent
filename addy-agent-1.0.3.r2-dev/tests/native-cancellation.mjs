import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {runSpecialists,organize,specialistDeny} from '../core.mjs';
process.env.USERPROFILE=new URL('.',import.meta.url).pathname.replace(/^\//,'');
const base='C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg=async n=>import(pathToFileURL(join(base,n,'lib/index.js')));
const {Context}=await pkg('cordis');const ctx=new Context();
const mount=async(n,c={})=>{const m=await pkg(n);ctx.plugin(m.default??m,c);return m;};
for(const n of ['dsh-session-projection','dsh-session','dsh-agent','dsh-system-prompt','dsh-tools'])await mount(n);
const llm=await mount('dsh-llm');
for(const n of ['dsh-fs-local','dsh-working-directory','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process'])await mount(n,n==='dsh-working-directory'?{defaultDirectory:process.cwd()}:{});
await new Promise(r=>setImmediate(r));
const abort=new AbortController();let entered=0;
const evidence={testedAt:new Date().toISOString(),transport:'Actual native AgentLoop/child cancellation with deterministic test-only LlmAdapter; no configured provider',events:[],pass:false};
ctx.on('session/event',(session,event)=>evidence.events.push({sessionId:session.id,event}));
class Adapter extends llm.LlmAdapter {
 async *stream(options){
  ++entered;if(entered===3)setTimeout(()=>abort.abort(new Error('intentional cancellation after all three real children entered')),0);
  await new Promise((resolve,reject)=>{if(options.signal.aborted)return reject(options.signal.reason);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 }
}
ctx.llm.registerAdapter(['native-cancellation'],new Adapter());
for(const name of specialistDeny)ctx.tools.register({name,description:'Delegation restriction sentinel',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},isConcurrencySafe:()=>true,execute:async()=>({unexpected:true})});
const parent=await ctx.agentLoop.create('native-cancellation-parent',{provider:'native-cancellation',model:'fixture'},{cwd:process.cwd()});
const timer=setTimeout(()=>abort.abort(new Error('cancellation test watchdog')),15000);
try{
 const reports=await runSpecialists({service:ctx.subagents,parent,signal:abort.signal,personas:['code-reviewer','security-auditor','test-engineer'],context:'Cancellation fixture only; no project work.'});
 evidence.entered=entered;evidence.reports=reports;evidence.full=organize({command:'ship',reports});
 assert.equal(entered,3);assert.equal(evidence.full.subagents.started,3);assert.equal(evidence.full.subagents.completed,0);assert.equal(evidence.full.subagents.failed,3);assert.equal(evidence.full.incomplete,true);
 evidence.childrenDisposed=reports.every(r=>!ctx.agents.get(r.childId));assert.equal(evidence.childrenDisposed,true);
 evidence.pass=true;
}finally{clearTimeout(timer);await ctx.fiber.dispose();writeFileSync(new URL('../evidence/native-cancellation.json',import.meta.url),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({pass:evidence.pass,entered,subagents:evidence.full?.subagents,childrenDisposed:evidence.childrenDisposed}));
