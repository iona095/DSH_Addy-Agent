// Reproducible package preparation; never writes the profile or upstream tree.
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root,upstream,revision,hash,skills,loadCommand,commandNames,personaNames } from './core.mjs';
const runtime = 'C:/Users/GNV/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh';
const require = createRequire(join(runtime,'package.json'));
const yaml = require('js-yaml');
const tracked=execFileSync('git',['-C',upstream,'ls-tree','-r','--full-tree',revision],{encoding:'utf8'}).trim().split('\n').map(line => {
 const m=/^(\d+) (\w+) ([a-f0-9]+)\t(.*)$/.exec(line); const bytes=readFileSync(join(upstream,m[4]));
 const actual=execFileSync('git',['-C',upstream,'hash-object','--no-filters',m[4]],{encoding:'utf8'}).trim();
 if(actual!==m[3]) throw new Error(`Upstream byte mismatch ${m[4]}`);
 return {path:m[4],gitBlob:m[3],sha256:hash(bytes),bytes:bytes.length};
});
const catalog=skills(); if(catalog.length!==25) throw new Error(`Expected 25 skills, got ${catalog.length}`);
const manifest={repository:'https://github.com/addyosmani/agent-skills',revision,runtimeVersion:JSON.parse(readFileSync(join(runtime,'package.json'))).version,
  sourcePolicy:'All tracked upstream bytes preserved, including commands, skills, personas, references, hooks and supporting scripts. Adaptation lives outside upstream.',
  commands:commandNames.map(n => { const c=loadCommand(n);return {name:n,path:`.claude/commands/${n}.md`,sha256:c.sha256,description:c.description};}),
  skills:catalog.map(({name,description}) => ({name,description})),personas:personaNames,files:tracked};
writeFileSync(join(root,'upstream-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const p = JSON.parse(JSON.stringify(yaml.load(readFileSync(join(runtime,'node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml'),'utf8'),{schema:yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:data=>({__jsExpr:data})})])})));
const config=p[0].insert[0].config;
config.id='addy-agent';config.name='Addy Agent';config.description=`Original Addy Agent Skills ${revision.slice(0,12)}, native PTC and concurrent specialists.`;config.order=10;
// Keep native tools but no generic plan-mode override of upstream approval wording.
// The original Addy /plan read-only procedure remains in its exact command definition.
config.plugins=config.plugins.filter(x => x.id!=='planning');
config.plugins.find(x=>x.id==='tool-plugin-manager').disabled=true;
const delegation=config.plugins.find(x=>x.id==='delegation');
for(const item of delegation.config) {
 if(['workflow-ptc','tool-workflow'].includes(item.id)) item.disabled=false;
 if(item.id==='workflow-ptc') item.config={provider:'spawn',maxConcurrentAgents:3};
}
config.plugins.push({id:'addy-compatibility',name:'@local/dsh-addy-agent'});
writeFileSync(join(root,'cordis.patch.yml'),yaml.dump([{insert:[{id:'preset-addy-agent',name:'@deepseek-ai/dsh-agent-preset',config}]}],{lineWidth:120}));
mkdirSync(join(root,'evidence'),{recursive:true});
const patch='C:/Users/GNV/.dsh/profiles/web/cordis.patch.yml';
const before={profilePatchSha256:hash(readFileSync(patch)),runtimeVersion:manifest.runtimeVersion,existingPresetDeclarationText:readFileSync(patch,'utf8').slice(readFileSync(patch,'utf8').indexOf('- id: agent-preset-registry')),templatePtcSha256:hash(readFileSync(join(runtime,'node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml')))};
writeFileSync(join(root,'evidence','before-install.json'),JSON.stringify(before,null,2));
console.log(JSON.stringify({revision,skills:catalog.length,commands:commandNames.length,personas:personaNames.length,trackedFiles:tracked.length,configPlugins:config.plugins.length}));
