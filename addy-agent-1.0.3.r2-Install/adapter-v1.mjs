import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root,upstream,revision,asset,skills,commandNames,personaNames,loadCommand,runSpecialists,organize,saveEvidence,concise,verifyIntegrity } from './core.mjs';
export const name = 'addy-agent-compatibility';
export const inject = ['tools','skills','commands','systemPrompt','subagents','workingDirectory'];
const textBlock = text => ({type:'text',text});
const message = text => Object.freeze({id:randomUUID(),role:'user',source:{kind:'user'},content:[textBlock(text)]});
const output = { schema:{type:'object'},render:(_args,value) => [textBlock(JSON.stringify(value,null,2))] };
const parameters = properties => ({type:'object',properties,additionalProperties:false});
export function apply(ctx) {
  verifyIntegrity();
  const state = new WeakMap();
  const evidenceDir = join(root,'evidence');
  function current(agent) {
    if (!agent) throw new Error('Addy adapter requires an initiating Agent');
    if (!state.has(agent)) state.set(agent,{command:null,arguments:'',operations:[],reports:[],errors:[]});
    return state.get(agent);
  }
  function enter(agent,command,args) {
    const definition = loadCommand(command,args);
    const s = current(agent);
    s.command=command; s.arguments=args; s.operations=[];s.reports=[];
    return definition;
  }
  for (const skill of skills()) ctx.effect(() => ctx.skills.register(skill));
  const routing = asset('skills/using-agent-skills/SKILL.md');
  ctx.effect(() => ctx.systemPrompt.section({name:'addy-methodology',order:150,interpolate:false,text:`${routing}\n\n# DSH execution-interface bindings (not replacement workflows)\nPinned upstream ${revision}, root ${upstream}.\nFor explicit slash commands OR natural-language lifecycle requests, select the original Addy command and call addy_command with its arguments BEFORE executing its workflow. The nine command names are ${commandNames.join(', ')}. The natural-language choice is made by this agent using the original routing guidance above, not a new router persona. If intent is ambiguous, ask; never convert a request to build one task into build auto. Other engineering intents load the relevant original skill.\nBoth invocation forms load the same byte-identical source using loadCommand. Native UI slash commands already enqueue that source: do not re-load or reset that invocation. Follow the returned original steps, approvals, ordering, output templates and stop conditions exactly.\nResolve agent-skills:<name> to the native skill tool name <name>. All 25 skills are registered; relative paths resolve from the returned skill resourceBase. Shared references are in ${join(upstream,'references')}. Do not copy repository-contributor AGENTS.md/CLAUDE.md into target projects.\nPrefer run_code for deterministic result processing and coordination. Discover actual tool schemas; use parallel execution only where runtime contracts admit it. Do not skip identical side-effecting executions. Never invent token savings or usage metrics.\nOriginal Agent tool persona calls map to addy_specialists. For /ship use exactly personas ["code-reviewer","security-auditor","test-engineer"] in ONE call; the adapter starts all three native children concurrently, loads the exact original persona as system context and denies nested delegation. Never emulate concurrent review with sequential roleplay. For /webperf use ["web-performance-auditor"], passing original explicit scope/artifacts/URL/mode context. Reports are independent; the main agent performs original /ship phases B/C, including direct accessibility/infrastructure/documentation checks and mandatory rollback. Load full reports before synthesis and include the original full-report output contract. Failed, aborted, refused, empty or max-token children leave incomplete review, never approval.\nThe native workflow tool is also available for programmatic coordination; this runtime's workflow agent() does NOT forward persona/toolFilter, so it must not replace addy_specialists for original persona invocations. Generic agents must not claim persona compliance.\nUse addy_results to persist and organize results with full provenance. Exact duplicate findings may be grouped; differing severity, assessment or evidence must stay attributed. Counts describe only observed adapter tool-result events, not unobservable external calls. Summaries never change success criteria or verdict.\nHuman approvals remain human decisions: no silent acceptance, inferred sign-off, or approval granted by PTC/scripts/subagents. If the approval or question channel is unavailable, stop at the original gate and request an explicit human response. /build auto still requires a recognized spec, clean baseline, full-plan affirmative, per-task tests/build/commit, and new sign-off for high-risk/irreversible work. Session plan mode and permission policy remain authoritative.\n` }));
  ctx.on('agent/created',async ({agent}) => {
    // An exact Agent scope needs its own commands dependency injection; the preset's
    // inject declaration does not authorize service property access on raw agent.ctx.
    const fiber = agent.ctx.inject(['commands'], commandCtx => {
      commandCtx.effect(() => {
      const disposers = commandNames.map(command => commandCtx.commands.register({name:command,
        description:loadCommand(command).description,input:{hint:command === 'build' ? '[auto|all]' : command === 'constraints' ? '[check|guard|ratchet]' : '[original arguments]'},
        handler:invocation => {
          const definition = enter(invocation.agent,command,invocation.rawInput);
          invocation.agent.followup(message(definition.instructions));
          return {kind:'success',text:`Queued original Addy /${command} (${definition.sha256.slice(0,12)}); workflow completion is not yet verified.`};
        }}));
      return () => disposers.reverse().forEach(d => d());
      });
    });
    ctx.effect(() => () => fiber.dispose());
    await fiber;
  });
  ctx.on('tools/result',(exec,result) => {
    if (!exec.agent || ['addy_results'].includes(exec.name)) return;
    const s = current(exec.agent);
    s.operations.push({task:exec.name,callId:exec.callId,rootCallId:exec.rootCallId,
      arguments:exec.arguments,result:result.isError ? null : result.value,error:result.isError ? result.error : null,
      verificationEvidence:result.content});
  });
  ctx.effect(() => ctx.tools.register({name:'addy_command',description:'Load the exact pinned original Addy lifecycle command. Natural and explicit invocation share this loader; this loads instructions, not a successful execution verdict.',
    parameters:{...parameters({command:{type:'string',enum:commandNames},arguments:{type:'string'}}),required:['command']},output,
    isConcurrencySafe:() => false,
    async execute(args,exec) {
      const def = enter(exec.agent,args.command,args.arguments ?? '');
      return {...def,definitionId:`${revision}/.claude/commands/${args.command}.md`};
    }}));
  ctx.effect(() => ctx.tools.register({name:'addy_specialists',description:'Execute exact upstream specialist personas in independent concurrent native DSH subagents. For ship, provide all three personas in one call. Returns attributed full reports and evidence; main agent must do original synthesis.',
    parameters:{...parameters({personas:{type:'array',items:{type:'string',enum:personaNames}},context:{type:'string'}}),required:['personas','context']},output,
    isConcurrencySafe:() => false,
    async execute(args,exec) {
      const s=current(exec.agent);
      if (!args.personas.length || new Set(args.personas).size !== args.personas.length) throw new Error('Provide nonempty unique persona list');
      if (s.command === 'ship' && JSON.stringify([...args.personas].sort()) !== JSON.stringify(['code-reviewer','security-auditor','test-engineer'].sort())) throw new Error('/ship requires all three exact original specialists in one concurrent call');
      const cwd = await ctx.workingDirectory.ensure(exec.agent,exec.signal);
      const reports = await runSpecialists({service:ctx.subagents,parent:exec.agent,signal:exec.signal,personas:args.personas,context:args.context,cwd});
      s.reports.push(...reports);
      const full = organize({command:s.command ?? 'specialists',arguments:s.arguments,reports,operations:s.operations});
      const ref=saveEvidence(evidenceDir,full);
      return { ...concise(full,ref),reports,decisionAuthority:'Main agent must execute original synthesis and rollback contract; incomplete reviews cannot establish GO.' };
    }}));
  ctx.effect(() => ctx.tools.register({name:'addy_results',description:'Persist full observed PTC results and specialist reports; group exact duplicate findings without discarding source attribution or differing assessments. Returns concise output with a hash-anchored full evidence reference. Does not approve or synthesize a verdict.',
    parameters:parameters({findings:{type:'array',items:{type:'object',properties:{text:{type:'string'},file:{type:'string'},line:{type:'integer'},severity:{type:'string'},assessment:{type:'string'},agent:{type:'string'},report:{type:'string'},evidence:{type:'array',items:{type:'string'}}},required:['text'],additionalProperties:false}},verificationEvidence:{type:'array',items:{type:'string'}}}),output,
    isConcurrencySafe:() => false,
    async execute(args,exec) {
      const s=current(exec.agent);
      const full=organize({command:s.command ?? 'unrouted',arguments:s.arguments,reports:s.reports,
        operations:s.operations,findings:args.findings ?? [],evidence:args.verificationEvidence ?? []});
      full.countCoverage='Observed completed tools/result events in this Agent since most recent addy_command; this in-flight addy_results call excluded. Child tool operations remain in child session logs.';
      return concise(full,saveEvidence(evidenceDir,full));
    }}));
}
