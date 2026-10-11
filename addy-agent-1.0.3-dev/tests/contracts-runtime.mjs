import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join,dirname} from 'node:path';
import * as compatibility from '../index.mjs';
import {commandNames,skills,asset,loadCommand,buildMode,constraintsMode,hash,specialistDeny} from '../core.mjs';
const installed='C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg=async name=>import(pathToFileURL(join(installed,name,'lib/index.js')));
const {Context}=await pkg('cordis');
const {createScope,bindScopeParent}=await pkg('dsh-scope');
const ctx=new Context();
const mount=async(name,config={})=>{const mod=await pkg(name);ctx.plugin(mod.default??mod,config);return mod;};
const evidence={testedAt:new Date().toISOString(),nodeVersion:process.version,runtimeVersion:JSON.parse(readFileSync(join(installed,'dsh-agent-loop/package.json'),'utf8')).version,artifactHashes:Object.fromEntries(['core.mjs','index.mjs','cordis.patch.yml'].map(name=>[name,hash(readFileSync(new URL(`../${name}`,import.meta.url)))])),transport:'deterministic test-only LlmAdapter; no configured provider or profile touched',nativeServices:[],cases:[],limitations:['Command entry and model request dispatch are tested, not LLM adherence to every upstream approval.','Standalone isolated process; actual bundle not installed.']};
let waiting;
const check=async(name,fn)=>{try{const detail=await fn();evidence.cases.push({name,pass:true,detail});}catch(e){evidence.cases.push({name,pass:false,error:{name:e.name,message:e.message,stack:e.stack}});}};
try {
 for(const name of ['dsh-session-projection','dsh-session','dsh-agent','dsh-system-prompt','dsh-tools','dsh-skill','dsh-commands']){await mount(name);evidence.nativeServices.push(name);}
 const llm=await mount('dsh-llm');
 for(const name of ['dsh-fs-local','dsh-working-directory','dsh-agent-loop','dsh-subagent','dsh-subagent-spawn-in-process']){await mount(name,name==='dsh-working-directory'?{defaultDirectory:process.cwd()}:{});evidence.nativeServices.push(name);}
 class FixtureAdapter extends llm.LlmAdapter {
  async *stream(options){
   if(waiting){waiting.resolve(options);waiting=undefined;}
   yield {type:'block-start',index:0,blockType:'text'};
   yield {type:'text-delta',index:0,text:'Contract dispatch fixture completed; no methodology execution claim.'};
   yield {type:'block-end',index:0,block:{type:'text',text:'Contract dispatch fixture completed; no methodology execution claim.'}};
   yield {type:'finish',reason:{kind:'stop'}};
  }
 }
 ctx.llm.registerAdapter(['contracts-fixture'],new FixtureAdapter());
 const scopeKey={name:'addy-standing-preset-fixture'};
 const standing=createScope(ctx,scopeKey);
 standing.ctx.plugin(compatibility);
 standing.ctx.plugin(await pkg('dsh-tool-skill'));
 await new Promise(resolve=>setImmediate(resolve));
 const create=async(id,key)=>{const h=await ctx.agents.create({sessionId:id,agentOptions:{provider:'contracts-fixture',model:'deterministic'},sessionMeta:{cwd:process.cwd()},setup:(_a,agent)=>{if(key)bindScopeParent(agent,key);}});return h.agent;};
 const addy=await create('contracts-addy',scopeKey);
 const second=await create('contracts-addy-second',scopeKey);
 const outsider=await create('contracts-outsider');
 const call=async(agent,name,args)=>agent.ctx.tools.execute({agent,name,callId:`contracts-${name}-${crypto.randomUUID()}`,arguments:args,signal:new AbortController().signal});
 await check('native Cordis scoped registration and per-agent commands',async()=>{
  assert.deepEqual(ctx.commands.list(addy).map(x=>x.name),[...commandNames].sort());
  assert.deepEqual(ctx.commands.list(second).map(x=>x.name),[...commandNames].sort());
  assert.equal(ctx.commands.list(outsider).length,0);
  assert.deepEqual(ctx.tools.schemas(addy).map(x=>x.name).sort(),['addy_command','addy_results','addy_specialists','skill']);
  assert.equal(ctx.tools.schemas(outsider).length,0);
  for(const name of ['addy_command','addy_results','addy_specialists']){const r=await call(outsider,name,{command:'spec'});assert.equal(r.isError,true);}
  assert.equal(await ctx.commands.execute(outsider,'/spec hello',[],new AbortController().signal),undefined);
  assert.notEqual(ctx.commands.find(addy,'spec'),ctx.commands.find(second,'spec'),'definitions registered per exact Agent');
  return {addyTools:ctx.tools.schemas(addy).map(x=>x.name),addyCommands:ctx.commands.list(addy),outsiderTools:ctx.tools.schemas(outsider),outsiderCommands:ctx.commands.list(outsider)};
 });
 await check('25 exact original skill bytes and directory resourceBase; outsider isolation',async()=>{
  const originals=skills();assert.equal(originals.length,25);
  const listed=await ctx.skills.list({scope:addy});assert.equal(listed.length,25);
  assert.equal((await ctx.skills.list({scope:outsider})).length,0);
  const rows=[];
  for(const original of originals){const loaded=await ctx.skills.get(original.name,{scope:addy});assert.equal(loaded.content,original.content);assert.deepEqual(loaded.resourceBase,{kind:'directory',path:dirname(original.path)});assert.equal(await ctx.skills.get(original.name,{scope:outsider}),undefined);const toolResult=await call(addy,'skill',{name:original.name});assert.equal(toolResult.isError,false,JSON.stringify(toolResult));assert.equal(toolResult.value.content,original.content);assert.deepEqual(toolResult.value.resourceBase,original.resourceBase);rows.push({name:original.name,sha256:hash(loaded.content),resourceBase:loaded.resourceBase});}
  return rows;
 });
 await check('upstream routing section is intact and scoped',async()=>{
  const a=await ctx.systemPrompt.assemble({agent:addy,scope:addy});const o=await ctx.systemPrompt.assemble({agent:outsider,scope:outsider});
  const section=a.sections.find(x=>x.name==='addy-methodology');assert.ok(section.text.startsWith(asset('skills/using-agent-skills/SKILL.md')));assert.ok(section.text.includes('addy_command'));assert.ok(!o.sections.some(x=>x.name==='addy-methodology'));
  return {section:section.name,originalRoutingSha256:hash(asset('skills/using-agent-skills/SKILL.md')),exactOriginalRoutingPrefix:true,outsiderSections:o.sections.map(x=>x.name)};
 });
 const argsByCommand={spec:'  feature "quoted"\nsecond line  ',plan:'\tfeature --scope=api ',build:' auto',test:'  src/api ',constraints:' guard',review:' HEAD~1..HEAD ',webperf:' https://example.test --mode=lab ', 'code-simplify':' src/complex.js ',ship:'  release-candidate '};
 for(const command of commandNames)await check(`explicit /${command} and addy_command share source and raw args`,async()=>{
  const raw=argsByCommand[command];const native=await call(addy,'addy_command',{command,arguments:raw});assert.equal(native.isError,false,JSON.stringify(native));const original=loadCommand(command,raw);assert.equal(native.value.source,original.source);assert.equal(native.value.arguments,raw);
  let resolve;const capture=new Promise(r=>resolve=r);waiting={resolve};
  const execution=await ctx.commands.execute(addy,`/${command}${raw}`,[],new AbortController().signal);assert.equal(execution.result.kind,'success');
  const timeout=new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('AgentLoop did not dispatch original command followup')),5000);t.unref();});const request=await Promise.race([capture,timeout]);
  const blocks=request.messages.flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text);
  assert.ok(blocks.includes(native.value.instructions),'native explicit handler queues exact same loadCommand instructions as automatic tool');
  return {rawArguments:raw,sourceSha256:native.value.sha256,definitionId:native.value.definitionId,originalSourceEqual:true,queuedInstructionsEqual:true,commandExecution:execution};
 });
 await check('argument semantics build auto/all and constraints check/guard/ratchet',async()=>{
  const cases=[];
  for(const [command,args] of [['build',' auto'],['build',' all'],['build',' task 1'],['constraints',' check'],['constraints',' guard'],['constraints',' ratchet'],['constraints',' setup']]){
   const r=await call(addy,'addy_command',{command,arguments:args});assert.equal(r.isError,false);assert.equal(r.value.arguments,args);assert.equal(r.value.source,loadCommand(command,args).source);cases.push({command,args,mode:command==='build'?buildMode(args):constraintsMode(args),sha256:r.value.sha256});
  }
  assert.equal(buildMode(' auto'),'autonomous');assert.equal(buildMode(' all'),'autonomous');assert.equal(buildMode(' task 1'),'single-task');for(const mode of ['check','guard','ratchet'])assert.equal(constraintsMode(` ${mode}`),mode);
  return cases;
 });
 await check('specialist delegation denied by actual tool runtime',async()=>{
  // Same native restrict primitive used by SpawnInProcessProvider; not merely hidden schemas.
  const sentinel={name:'contracts_delegation_sentinel',description:'Fixture nested delegation',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'sentinel'}]},isConcurrencySafe:()=>true,execute:async()=>({ran:true})};ctx.tools.register(sentinel);
  const child=await create('contracts-restricted-child',scopeKey);child.ctx.tools.restrict({deny:['contracts_delegation_sentinel','addy_specialists']});
  assert.ok(!ctx.tools.schemas(child).some(t=>t.name==='contracts_delegation_sentinel'||t.name==='addy_specialists'));
  const denial=await call(child,'contracts_delegation_sentinel',{});assert.equal(denial.isError,true);
  const specialistDenial=await call(child,'addy_specialists',{personas:['code-reviewer'],context:'no execution allowed'});assert.equal(specialistDenial.isError,true);
  return {denial,specialistDenial,note:'Exact full specialist activation and direct subagent/workflow denial belong to native-runtime.mjs companion; this independently verifies scoped inherited Addy tool denial.'};
 });
 evidence.pass=evidence.cases.every(c=>c.pass);
} catch(e){evidence.pass=false;evidence.fatal={name:e.name,message:e.message,stack:e.stack};}
finally {await ctx.fiber.dispose();writeFileSync(new URL('../evidence/contracts-runtime.json',import.meta.url),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({pass:evidence.pass,cases:evidence.cases.map(({name,pass,error})=>({name,pass,error})),fatal:evidence.fatal},null,2));
if(!evidence.pass)process.exitCode=1;
