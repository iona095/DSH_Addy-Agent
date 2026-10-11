import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import * as adapter from '../index.mjs';
process.env.USERPROFILE=new URL('.',import.meta.url).pathname.replace(/^\//,'');
const base='C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg=async n=>import(pathToFileURL(join(base,n,'lib/index.js')));
const {Context}=await pkg('cordis');const ctx=new Context();
const mount=async(n,c={})=>{const m=await pkg(n);await ctx.plugin(m.default??m,c);return m;};
for(const n of ['dsh-session-projection','dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','dsh-skill','dsh-commands'])await mount(n);
const llm=await mount('dsh-llm');for(const n of ['dsh-fs-local','dsh-working-directory','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process'])await mount(n,n==='dsh-working-directory'?{defaultDirectory:process.cwd()}:{});
const evidence={testedAt:new Date().toISOString(),transport:'Real native activation + exact-child local delegation registrations + actual Addy adapter; deterministic test-only LlmAdapter',denials:[],pass:false};
let entered=0,unexpected=0;const barrier=Promise.withResolvers();
ctx.on('agent/created',async({agent})=>{
 if(!agent.session.header.parentSession)return;
 const fiber=agent.ctx.inject(['tools'],c=>{c.effect(()=>{const disposers=['subagent','spawn_teammate','team_task_create'].map(name=>c.tools.register({name,description:'Child-local delegation fixture (not globally restrictable)',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[]},isConcurrencySafe:()=>true,execute:async()=>{unexpected++;return {unexpected:true};}}));return ()=>disposers.forEach(d=>d());});});await fiber;
});
class Adapter extends llm.LlmAdapter {
 async *stream(options){
  const child=ctx.agents.get(options.sessionId);
  for(const name of ['subagent','spawn_teammate','team_task_create']){
   const r=await ctx.tools.execute({agent:child,name,callId:`denied-${name}-${child.id}`,arguments:{},signal:options.signal});
   evidence.denials.push({childId:child.id,name,result:r});assert.equal(r.isError,true);assert.ok(JSON.stringify(r).includes('Nested delegation disabled for original Addy specialists'));
  }
  if(++entered===3)barrier.resolve();await barrier.promise;
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Independent native scoped specialist report.'};yield {type:'block-end',index:0,block:{type:'text',text:'Independent native scoped specialist report.'}};yield {type:'finish',reason:{kind:'stop'}};
 }
}
ctx.llm.registerAdapter(['native-scoped-specialists'],new Adapter());await ctx.plugin(adapter);
try{
 const parent=await ctx.agentLoop.create('native-scoped-specialist-parent',{provider:'native-scoped-specialists',model:'fixture'},{cwd:process.cwd()});
 const result=await ctx.tools.execute({agent:parent,name:'addy_specialists',callId:'actual-scoped-fanout',arguments:{personas:['code-reviewer','security-auditor','test-engineer'],context:'Read-only fixture review; no nested delegation.'},signal:new AbortController().signal});
 evidence.result=result;evidence.entered=entered;evidence.unexpectedDelegations=unexpected;
 assert.equal(result.isError,false);assert.equal(entered,3);assert.equal(unexpected,0);assert.equal(result.value.subagents.completed,3);assert.equal(evidence.denials.length,9);evidence.pass=true;
}finally{await ctx.fiber.dispose();writeFileSync(new URL('../evidence/native-scoped-specialists.json',import.meta.url),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({pass:evidence.pass,entered,denials:evidence.denials.length,unexpected}));
