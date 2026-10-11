import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {organize,concise,hash} from '../core.mjs';
const installed='C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const pkg=async name=>import(pathToFileURL(join(installed,name,'lib/index.js')));
const {Context}=await pkg('cordis');const ctx=new Context();
const mount=async(name,config={})=>{const m=await pkg(name);ctx.plugin(m.default??m,config);};
for(const name of ['dsh-session-projection','dsh-session','dsh-system-prompt','dsh-fs-local','dsh-subprocess-local']) await mount(name);
await mount('dsh-tools',{mode:'ptc'});
await mount('dsh-sandbox-policy',{mode:'danger-full-access',workspaceRoot:process.cwd()});await mount('dsh-sandbox-local');await mount('dsh-ptc-runtime-node');
await new Promise(r=>setImmediate(r));
const operations=[];let sideEffects=0,active=0,maxActive=0;
ctx.on('tools/result',(exec,result)=>{if(exec.name==='run_code')return;operations.push({task:exec.name,callId:exec.callId,arguments:exec.arguments,result:result.isError?null:result.value,error:result.isError?result.error:null,verificationEvidence:result.content});});
for(const name of ['native_repeat','native_effect','native_failure'])ctx.tools.register({name,description:'Test-only native PTC binding',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_args,v)=>[{type:'text',text:JSON.stringify(v)}]},isConcurrencySafe:()=>name!=='native_effect',async execute(){active++;maxActive=Math.max(maxActive,active);try{await new Promise(r=>setTimeout(r,20));if(name==='native_failure')throw new Error('intentional native bound tool error: retained detail');if(name==='native_effect')return {sequence:++sideEffects};return {same:'result',evidence:'full evidence marker'};}finally{active--;}}});

const evidence={runtimeVersion:JSON.parse(readFileSync(join(installed,'dsh-ptc-runtime-node/package.json'),'utf8')).version,transport:'Real Node PTC subprocess and real ToolRuntime bindings; no LLM request',availableSchemas:ctx.tools.schemas(),pass:false};
try{
const code=`const results=await Promise.all([tools.native_repeat({}),tools.native_repeat({})]);\nresults.push(await tools.native_effect({}));results.push(await tools.native_effect({}));\ntry { await tools.native_failure({}); } catch(e) { results.push({error:{name:e.name,message:e.message,toolName:e.toolName??null}}); }\nconsole.log('native evidence retained'); return {results};`;
const result=await ctx.tools.execute({name:'run_code',callId:'native-ptc-root',arguments:{description:'Verify actual PTC bindings',code},signal:new AbortController().signal});
evidence.result=result;evidence.operations=operations;evidence.sideEffects=sideEffects;evidence.maxActive=maxActive;
assert.equal(result.isError,false);assert.equal(operations.length,5);assert.equal(sideEffects,2);assert.equal(maxActive,2);
const full=organize({command:'native-ptc',operations,evidence:['native evidence retained']});assert.equal(full.counts.toolCalls,5);assert.equal(full.counts.duplicateResults,1);assert.equal(full.counts.uniqueResults,4);assert.equal(full.counts.failures,1);assert.ok(JSON.stringify(full).includes('retained detail'));evidence.full=full;
const ref={path:new URL('../evidence/native-ptc.json',import.meta.url).pathname,pointer:'/full',sha256:hash(JSON.stringify(full)),bytes:Buffer.byteLength(JSON.stringify(full))};evidence.concise=concise(full,ref);assert.equal(evidence.concise.fullResult.sha256,ref.sha256);evidence.pass=true;
}finally{await ctx.fiber.dispose();writeFileSync(new URL('../evidence/native-ptc.json',import.meta.url),JSON.stringify(evidence,null,2));}
console.log(JSON.stringify({pass:evidence.pass,counts:evidence.full?.counts,sideEffects,maxActive},null,2));
