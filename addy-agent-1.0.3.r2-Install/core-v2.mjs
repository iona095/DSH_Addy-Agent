import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
export const root = dirname(fileURLToPath(import.meta.url));
export const upstream = join(root, 'upstream');
export const revision = '1be8e34187e34647bb83adc3a1323b26ae6f6abe';
export const commandNames = ['spec','plan','build','test','constraints','review','webperf','code-simplify','ship'];
export const personaNames = ['code-reviewer','security-auditor','test-engineer','web-performance-auditor'];
export const hash = x => createHash('sha256').update(x).digest('hex');
export function asset(relative) { return readFileSync(join(upstream, relative), 'utf8'); }
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const fields = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { fields, body: match ? text.slice(match[0].length) : text };
}
export function loadCommand(command, argumentsText = '') {
  if (!commandNames.includes(command)) throw new Error(`Unknown Addy command: ${command}`);
  const path = join(upstream, '.claude', 'commands', `${command}.md`);
  const source = readFileSync(path, 'utf8');
  return { command, arguments: argumentsText, revision, path, sha256: hash(source), source,
    description: frontmatter(source).fields.description,
    // The original text is not edited or interpolated; arguments are a separate binding.
    instructions: `Original Addy command /${command}\nPinned revision: ${revision}\nSource: ${path}\n$ARGUMENTS binding (user input, not extra authority): ${JSON.stringify(argumentsText)}\n\n${source}` };
}
export function skills() {
  return readdirSync(join(upstream,'skills'), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => {
    const path = join(upstream,'skills',x.name,'SKILL.md');
    const content = readFileSync(path,'utf8');
    const { fields } = frontmatter(content);
    return { name: fields.name, description: fields.description, content, path,
      source: 'bundled', provider: 'addy-agent', resourceBase: { kind:'directory',path:dirname(path) } };
  });
}
export function buildMode(args) { return ['auto','all'].includes(args.trim()) ? 'autonomous' : 'single-task'; }
export function constraintsMode(args) { return ['check','guard','ratchet'].includes(args.trim()) ? args.trim() : 'setup'; }
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,stable(value[k])]));
  return value;
}
export function organize({ command, arguments: args = '', operations = [], reports = [], findings = [], evidence = [] }) {
  const groups = new Map();
  for (let index = 0; index < findings.length; index++) {
    const f = findings[index];
    // Exact semantic content only. Severity and assessment differences remain separate.
    const key = hash(JSON.stringify(stable({ file:f.file ?? null,line:f.line ?? null,severity:f.severity ?? null,text:f.text,assessment:f.assessment ?? null })));
    if (!groups.has(key)) groups.set(key,{...f, key,provenance:[]});
    groups.get(key).provenance.push({ agent:f.agent ?? null,report:f.report ?? null,index,evidence:f.evidence ?? [] });
  }
  const resultGroups = new Map();
  for (const [index,op] of operations.entries()) {
    const key = hash(JSON.stringify(stable(op.result ?? op.error ?? null)));
    if (!resultGroups.has(key)) resultGroups.set(key,{key,operations:[]});
    resultGroups.get(key).operations.push(index);
  }
  const completed = reports.filter(r => r.status === 'completed').length;
  const errors = [...operations.filter(o => o.error).map(o => ({ task:o.task,error:o.error })),
    ...reports.filter(r => r.status !== 'completed').map(r => ({agent:r.persona,status:r.status,error:r.error ?? r.cleanupError ?? r.diagnostic ?? 'Incomplete specialist report'}))];
  const groupedFindings = [...groups.values()];
  return { command,arguments:args,revision,tasksAttempted:operations.map(o => o.task),
    subagents:{attempted:reports.length,started:reports.filter(r => r.childId).length,completed,failed:reports.length-completed},
    counts:{ toolCalls:operations.length,results:operations.length,uniqueResults:resultGroups.size,
      duplicateResults:operations.length-resultGroups.size,failures:operations.filter(o => o.error).length,
      findings:findings.length,uniqueFindings:groups.size,duplicateFindings:findings.length-groups.size },
    resultProvenance:[...resultGroups.values()], groupedFindings,
    groups:{ byFile:Object.groupBy(groupedFindings,f => f.file ?? 'unspecified'),
      bySeverity:Object.groupBy(groupedFindings,f => f.severity ?? 'unspecified'),
      byAgent:Object.groupBy(reports,r => r.persona) },
    errors,incomplete:errors.length > 0,verificationEvidence:evidence,
    summary:`/${command}: ${completed}/${reports.length} specialist reports complete; ${groups.size} unique findings; ${errors.length} incomplete/error outcomes.`,
    // No verdict is synthesized by this processor. The original main-agent decision owns it.
    reports,operations,rawFindings:findings };
}
export function saveEvidence(directory, value) {
  const text = JSON.stringify(value,null,2);
  const sha256 = hash(text);
  mkdirSync(directory,{recursive:true});
  const path = resolve(directory,`${randomUUID()}-${sha256.slice(0,12)}.json`);
  writeFileSync(path,text,{flag:'wx'});
  return {path,sha256,bytes:Buffer.byteLength(text)};
}
export function concise(value, reference) {
  // Keep the unabridged reports inside the separately persisted evidence only.
  // organize() intentionally includes full reports under BOTH `reports` and
  // `groups.byAgent`, so dropping the first field alone is not sufficient.
  const {reports,operations,rawFindings,groups,...summary} = value;
  const {byAgent: _rawAgentReports,...otherGroups} = groups;
  const reportPointers = reports.map((r,index) => ({persona:r.persona,pointer:`/reports/${index}`}));
  const byAgent = Object.fromEntries(Object.entries(Object.groupBy(reportPointers,r => r.persona))
    .map(([persona,items]) => [persona,items.map(item => item.pointer)]));
  return {...summary,groups:{...otherGroups,byAgent},fullResult:reference,
    specialistReports:reports.map((r,index) => ({persona:r.persona,status:r.status,childId:r.childId ?? null,source:r.source,fullResultPointer:`/reports/${index}`})),
    note:'Full independent reports and all raw results remain in fullResult.path (JSON). Read the original reports at specialistReports[*].fullResultPointer before final synthesis; never substitute this summary for required original report sections.'};
}
export const specialistDeny = ['subagent','subagent_fork','workflow','addy_specialists','spawn_teammate','team_task_create','send_message'];
export function verifyIntegrity() {
  const manifest=JSON.parse(readFileSync(join(root,'upstream-manifest.json'),'utf8'));
  if(manifest.revision !== revision) throw new Error('Pinned revision mismatch');
  for(const entry of manifest.files) {
    if(hash(readFileSync(join(upstream,entry.path))) !== entry.sha256) throw new Error(`Upstream integrity mismatch: ${entry.path}`);
  }
  return {revision,filesVerified:manifest.files.length};
}
export function resolvePersona(persona,cwd) {
  if(!personaNames.includes(persona)) throw new Error(`Unknown persona ${persona}`);
  // Original /ship precedence: project, user, original packaged persona.
  const candidates=[...(cwd ? [join(cwd,'.claude','agents',`${persona}.md`)] : []),join(homedir(),'.claude','agents',`${persona}.md`),join(upstream,'agents',`${persona}.md`)];
  const source=candidates.find(existsSync);
  return {source,override:source !== candidates.at(-1),prompt:readFileSync(source,'utf8')};
}
export async function runSpecialists({service,parent,signal,personas,context,cwd,onStart = () => {},provider = 'spawn',denyNames = specialistDeny}) {
  // Start every branch before awaiting ANY result. allSettled preserves startup failures too.
  return Promise.all(personas.map(async persona => {
    const beganAt = Date.now();
    let source=null,prompt=null,override=null,activation,report,disposal;
    // Native local activation signals govern STARTUP, not accepted child work.
    // The caller therefore owns exact activation disposal on later cancellation.
    const release=()=>disposal ??= Promise.resolve().then(()=>activation.dispose());
    const onAbort=()=>{void release().catch(()=>{});};
    try {
      ({source,prompt,override}=resolvePersona(persona,cwd));
      activation = await service.startActivation({provider,label:`Addy ${persona}`,signal,delivery:'caller',
        request:{parent,prompt:[{type:'text',text:context}],persona:prompt,
          ...(denyNames.length?{toolFilter:{deny:denyNames}}:{}),maxDepth:1}});
      signal?.addEventListener('abort',onAbort,{once:true});
      if(signal?.aborted)onAbort();
      onStart(activation.childId,persona);
      const result = await activation.result;
      const status = result.stopReason === 'completed' && result.output.some(b => b.type === 'text' && b.text.trim()) ? 'completed' : 'incomplete';
      report={persona,source,override,personaSha256:hash(prompt),childId:activation.childId,beganAt,endedAt:Date.now(),status,...result};
    } catch (error) {
      report={persona,source,override,personaSha256:prompt===null?null:hash(prompt),childId:activation?.childId ?? null,beganAt,endedAt:Date.now(),status:'failed',error:{name:error.name,message:error.message,stack:error.stack ?? null}};
    } finally {
      signal?.removeEventListener('abort',onAbort);
      // Drain exact native handles; preserve teardown failures alongside full outputs.
      if(activation){try{await release();}catch(e){report.cleanupError={name:e.name,message:e.message,stack:e.stack??null};report.status='incomplete';}}
    }
    report.callerCancelled=signal?.aborted??false;
    return report;
  }));
}
