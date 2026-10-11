// Temporary native host verifier. No fake LLM adapter, settings writes or replacement server.
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {commandNames,loadCommand,specialistDeny,resolvePersona} from '../../core.mjs';
export const inject=['agentLoop','agentPresets','agentDefaultModel','agents','tools','commands','skills','systemPrompt','workingDirectory'];
const sha=x=>createHash('sha256').update(x).digest('hex');
const msg=text=>({id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text}]});
export function apply(ctx,config) {
 const abort=new AbortController(),owned=[];
 const data={startedAt:new Date().toISOString(),transport:'Actual installed live host and configured provider; NO deterministic/fake adapter',phase:'starting',pass:false,cases:[],agents:[],streams:[],operations:[],sessionEvents:[],errors:[]};
 mkdirSync(config.outputDirectory,{recursive:true});
 const output=join(config.outputDirectory,'live-installed-v3.json');
 const checkpoint=()=>writeFileSync(output,JSON.stringify(data,null,2));
 const ids=new Set();let childActive=0;
 ctx.on('agent/created',({agent})=>{
  if(resolve(ctx.workingDirectory.get(agent.session)) !== resolve(config.fixtureDirectory)) return;
  ids.add(agent.id);
  data.agents.push({id:agent.id,at:Date.now(),options:agent.options,logicalAdapterTools:['addy_command','addy_specialists','addy_results'].filter(n=>ctx.tools.get(n,agent)),deniedDelegationVisible:specialistDeny.filter(n=>ctx.tools.get(n,agent))});checkpoint();
 });
 ctx.on('session/event',(session,event)=>{if(ids.has(session.id)){data.sessionEvents.push({sessionId:session.id,event});checkpoint();}});
 ctx.on('tools/result',(exec,result)=>{if(ids.has(exec.agent?.id)){data.operations.push({agentId:exec.agent.id,name:exec.name,callId:exec.callId,rootCallId:exec.rootCallId,arguments:exec.arguments,result,at:Date.now()});checkpoint();}});
 ctx.on('llm/stream',async function*(options,next){
  if(!ids.has(options.sessionId)){yield* next();return;}
  const system=options.messages.filter(m=>m.role==='system').flatMap(m=>m.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const persona=['code-reviewer','security-auditor','test-engineer','web-performance-auditor'].find(p=>system.includes(resolvePersona(p,config.fixtureDirectory).prompt));
  const entry={agentId:options.sessionId,provider:options.provider,model:options.model,startedAt:Date.now(),persona:persona??null,systemSha256:sha(system),toolSchemas:(options.tools??[]).map(t=>t.name)};
  if(persona){entry.activeChildrenAtStart=++childActive;data.maximumConcurrentChildStreams=Math.max(data.maximumConcurrentChildStreams??0,childActive);const p=resolvePersona(persona,config.fixtureDirectory);entry.personaSource=p.source;entry.personaSha256=sha(p.prompt);entry.override=p.override;}
  data.streams.push(entry);checkpoint();
  try{yield* next();}catch(e){entry.error={name:e.name,message:e.message};throw e;}finally{entry.endedAt=Date.now();if(persona)--childActive;checkpoint();}
 });
 const run=async()=>{
  try{
   data.defaultBefore=ctx.agentDefaultModel.currentSelection();data.presetRosterBefore=await ctx.agentPresets.list();
   data.composition=ctx.agentPresets.inspectCompositions();
   const preset=await ctx.agentPresets.resolve('addy-agent');data.preset=preset;checkpoint();
   if(preset.status==='failed'||preset.error)throw new Error(`Addy preset activation failed: ${JSON.stringify(preset)}`);
   const source=ctx.agents.get(config.sourceSessionId);if(!source)throw new Error('Source configured-model session is not live');
   const agentOptions={...source.options};data.configuredModel=agentOptions;
   const create=async label=>{
    const handle=await ctx.agentLoop.createAgent(ctx,{sessionId:`addy-live-${label}-${randomUUID()}`,agentOptions,meta:{cwd:config.fixtureDirectory,agentPreset:'addy-agent'},signal:abort.signal,setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'addy-agent');}});
    owned.push(handle);return handle.agent;
   };
   const wait=async(agent,label)=>{
    const timer=setTimeout(()=>{data.errors.push({case:label,error:'Live scenario timeout after 360000ms; cancelled and drained'});agent.cancel({kind:'hook',reason:'bounded live verification timeout'});},360000);
    try{await agent.whenIdle();}finally{clearTimeout(timer);}checkpoint();
   };
   const probe=await create('probe');data.phase='installed-scope-probes';checkpoint();
   data.commandCatalog=ctx.commands.list(probe);data.modelTools=ctx.tools.schemas(probe);data.scopeComposition=ctx.agentPresets.inspectCompositions(probe.ctx);
   const originals=await ctx.skills.list({scope:probe});data.skillCatalog=originals.map(s=>({name:s.name,description:s.description,resourceBase:s.resourceBase}));
   if(!commandNames.every(n=>data.commandCatalog.some(c=>c.name===n)))throw new Error('Missing installed Addy commands');
   // schemas() enumerates logical registrations, not the collapsed model surface.
   const direct=await ctx.tools.execute({name:'addy_command',agent:probe,callId:`live-direct-${randomUUID()}`,arguments:{command:'review'},signal:abort.signal});data.directNativeCollapse=direct;
   if(!direct.isError)throw new Error('Installed preset permits direct native execution instead of requiring PTC');
   const ptc=await ctx.tools.execute({name:'run_code',agent:probe,callId:`live-ptc-${randomUUID()}`,arguments:{description:'Installed Addy source-preserving dispatch probe',code:`const c=await tools.addy_command({command:'review',arguments:' HEAD~1..HEAD'}); const s=await tools.skill({name:'code-review-and-quality'}); return {command:c,skill:s};`},signal:abort.signal});
   data.installedPtc=ptc;
   if(ptc.isError)throw new Error(`Installed PTC dispatch failed: ${JSON.stringify(ptc.error)}`);
   const canonical=ptc.value.result;
   if(canonical.command.source!==loadCommand('review',' HEAD~1..HEAD').source || canonical.command.arguments!==' HEAD~1..HEAD')throw new Error('Installed command definition/argument roundtrip mismatch');
   if(canonical.skill.content!==readFileSync(join(config.fixtureDirectory,'../../upstream/skills/code-review-and-quality/SKILL.md'),'utf8'))throw new Error('Installed skill byte roundtrip mismatch');
   data.cases.push({name:'installed preset scopes, commands and actual Node PTC',pass:true});checkpoint();
   const workflow=ctx.agentPresets.serviceFor(probe,'workflowEngine');if(!workflow)throw new Error('Scoped native workflowEngine missing');
   const wf=workflow.start({parent:probe,signal:abort.signal,script:`return await parallel([async()=>({probe:'A'}),async()=>({probe:'B'}),async()=>({probe:'C'})]);`,meta:{name:'addy-installed-native-workflow-probe',description:'Native scoped workflow helper verification without model calls'}});
   try{data.workflow=await wf.result;if(data.workflow.stopReason!=='completed')throw new Error(JSON.stringify(data.workflow));}finally{await wf.dispose();}
   data.cases.push({name:'installed isolated native workflow helpers',pass:true});checkpoint();
   const review=await create('natural-review');data.naturalReviewSession=review.id;data.phase='configured-provider-natural-review';checkpoint();
   review.followup(msg('Please review the committed changes in HEAD~1..HEAD of this synthetic fixture, focusing on correctness, security and tests. This is a read-only review, not remediation. Do not modify files or commit anything. Use the original Addy process and its required full output. No deployments, network or secrets are involved; test with node --test api.test.mjs if appropriate.'));
   await wait(review,'natural-review');
   const reviewCalls=data.operations.filter(o=>o.agentId===review.id);
   data.cases.push({name:'real-provider natural-language review loads the same original review command',pass:reviewCalls.some(o=>o.name==='addy_command'&&o.arguments.command==='review'&&!o.result.isError)});checkpoint();
   const ship=await create('slash-ship');data.shipSession=ship.id;data.phase='configured-provider-slash-ship';checkpoint();
   data.slashExecution=await ctx.commands.execute(ship,'/ship Review HEAD~1..HEAD only. This synthetic change touches three files and includes untrusted input evaluation, unbound query construction and known failing tests, so fan-out is required. Run the original three specialists concurrently with full independent reports; do not remediate or modify files, do not commit or deploy. Use node --test api.test.mjs to verify actual test failures. Browser/a11y applies only if this non-UI fixture warrants it; do not invent measurements. Complete original parent phases B/C, all full reports, GO/NO-GO and rollback triggers/procedure/RTO. No risks are accepted by the user. Save result evidence using addy_results; retain the native full reports in final output.',[],abort.signal);
   await wait(ship,'slash-ship');
   const shipOps=data.operations.filter(o=>o.agentId===ship.id);const fan=shipOps.find(o=>o.name==='addy_specialists');
   const childStreams=data.streams.filter(s=>s.persona&&data.agents.some(a=>a.id===s.agentId));
   data.cases.push({name:'real-provider slash ship invokes native concurrent specialist fan-out',pass:Boolean(fan&&!fan.result.isError&&data.maximumConcurrentChildStreams>=3),childStreamCount:childStreams.length,maxConcurrentChildStreams:data.maximumConcurrentChildStreams??0});
   data.defaultAfter=ctx.agentDefaultModel.currentSelection();data.presetRosterAfter=await ctx.agentPresets.list();
   data.cases.push({name:'default model selection unchanged',pass:JSON.stringify(data.defaultBefore)===JSON.stringify(data.defaultAfter)});
   data.phase='completed';data.pass=data.cases.every(c=>c.pass)&&data.errors.length===0;data.completedAt=new Date().toISOString();checkpoint();
  }catch(e){data.phase='error';data.errors.push({name:e.name,message:e.message,stack:e.stack});checkpoint();}
  finally{for(const h of owned.reverse()){try{await h.dispose();}catch(e){data.errors.push({cleanup:e.message});}}data.quiescentAt=new Date().toISOString();checkpoint();}
 };
 const task=run();
 ctx.effect(()=>async()=>{abort.abort(new Error('Verification bundle removed'));for(const h of owned){h.agent.cancel({kind:'disposed'});}await task;});
}
