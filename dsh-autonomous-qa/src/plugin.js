import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { scanProject } from './scanner.js';
import { buildSemanticIndex, traceCalls } from './semantic.js';
import { ChromiumDriver } from './browser.js';
import { executeStep,runScenario } from './engine.js';
import { auditVisual,enrichVisualFindings } from './visual.js';
import { explorePage } from './explorer.js';
import { buildMarkupIndex,planTagCombinations } from './markup.js';
import { runCombinationCases } from './combination-runtime.js';
import {planAlgorithmicTagCombinations,planModelTransitions,rankFaultCandidates} from './algorithms.js';
import {runComparison} from './benchmark.js';
import {traceInteraction} from './interaction.js';

export const name='dsh-autonomous-frontend-qa';
export const inject=['tools'];
const sessions=new Map();
const jsonOut={schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]};
const out=value=>JSON.stringify(value);
const bounded=async task=>{
  try{return out(await task());}catch(e){return out({ok:false,error:e instanceof Error?e.message:String(e)});}
};

export function apply(ctx) {
  const register=spec=>ctx.tools.register(defineTool(spec));
  register({
    name:'frontend_qa_scan',description:'Read every supported front-end file and build a cross-file import, functions, event, and CSS rule index with original file and line references. Returns a JSON index (may be large). Does not claim code correctness.',
    parameters:{projectRoot:{type:'string',required:true,description:'Absolute path to authorized project'}},output:jsonOut,
    async execute(args){return bounded(async()=>{const root=path.resolve(args.projectRoot);return {scan:scanProject(root),semantic:buildSemanticIndex(root),markup:buildMarkupIndex(root)};});},
  });
  register({
    name:'frontend_qa_markup',description:'Index every supported HTML/Vue/JSX/TSX tag, parent/child relation, event handler, reactive binding, conditional rendering and cross-file component reference. All links are STATIC evidence, not proof of correctness.',
    parameters:{projectRoot:{type:'string',required:true},file:{type:'string'}},output:jsonOut,
    async execute(args){return bounded(async()=>{const index=buildMarkupIndex(path.resolve(args.projectRoot));return args.file?{summary:index.summary,nodes:index.nodes.filter(x=>x.file===args.file),edges:index.edges.filter(x=>x.from.startsWith(args.file+':')),diagnostics:index.diagnostics.filter(x=>x.file===args.file),limitations:index.limitations}:index;});}
  });
  register({
    name:'frontend_qa_plan_combinations',description:'Generate bounded deterministic input/tag-state combinations with pairwise coverage, file/line evidence and UNKNOWN oracles unless independently supplied. Plans DO NOT execute.',
    parameters:{projectRoot:{type:'string',required:true},file:{type:'string'},maxCases:{type:'number'},contractsJson:{type:'string'}},output:jsonOut,
    async execute(args){return bounded(async()=>{const index=buildMarkupIndex(path.resolve(args.projectRoot));const contracts=args.contractsJson?JSON.parse(args.contractsJson):{};return planTagCombinations(index,{file:args.file,maxCases:args.maxCases,contracts});});}
  });
  register({
    name:'frontend_qa_test_combinations',description:'Run independent-rule tag-combination tests in a disposable, localhost-only test environment, restoring state before each case. Requires explicit authorization and approved oracle rules. Does not infer expected behavior from source code.',
    parameters:{session:{type:'string',required:true},projectRoot:{type:'string',required:true},group:{type:'string',required:true},pageUrl:{type:'string',required:true},submitSelector:{type:'string'},rulesJson:{type:'string',required:true},maxCases:{type:'number'},strategy:{type:'string',description:'baseline or algorithm; algorithm uses explicit forbidden constraints'},constraintsJson:{type:'string'},seed:{type:'number'},acknowledgeDisposableEnvironment:{type:'boolean',required:true}},output:jsonOut,
    async execute(args){return bounded(async()=>{const browser=sessions.get(args.session);if(!browser)throw new Error('Unknown session');const markup=buildMarkupIndex(path.resolve(args.projectRoot));const plan=args.strategy==='algorithm'?planAlgorithmicTagCombinations(markup,{maxCases:args.maxCases,constraintsByGroup:args.constraintsJson?JSON.parse(args.constraintsJson):{},seed:args.seed??11}):args.strategy===undefined||args.strategy==='baseline'?planTagCombinations(markup,{maxCases:args.maxCases}):(()=>{throw new Error('Unknown strategy')})();const group=plan.groups.find(g=>g.group===args.group);if(!group)throw new Error('Unknown combination group');return runCombinationCases(browser,group,{pageUrl:args.pageUrl,submitSelector:args.submitSelector,rules:JSON.parse(args.rulesJson),maxCases:args.maxCases,acknowledgeDisposableEnvironment:args.acknowledgeDisposableEnvironment});});}
  });
  register({
    name:'frontend_qa_plan_algorithmic',description:'Generate risk-weighted, constraint-aware pairwise scenarios from source-derived tags. Provides coverage and explicit unknown oracles; plans do not execute and are not IPOG.',
    parameters:{projectRoot:{type:'string',required:true},file:{type:'string'},maxCases:{type:'number'},constraintsJson:{type:'string',description:'JSON object group -> forbidden state rules'},seed:{type:'number'}},output:jsonOut,
    async execute(args){return bounded(async()=>{const markup=buildMarkupIndex(path.resolve(args.projectRoot));return planAlgorithmicTagCombinations(markup,{file:args.file,maxCases:args.maxCases,constraintsByGroup:args.constraintsJson?JSON.parse(args.constraintsJson):{},seed:args.seed??11});});}
  });
  register({
    name:'frontend_qa_plan_model_paths',description:'BFS transition/path coverage from a user-confirmed state-machine model, not proof of UI correctness.',
    parameters:{modelJson:{type:'string',required:true},maxDepth:{type:'number'},maxSequences:{type:'number'}},output:jsonOut,
    async execute(args){return bounded(async()=>planModelTransitions(JSON.parse(args.modelJson),{maxDepth:args.maxDepth,maxSequences:args.maxSequences}));}
  });
  register({
    name:'frontend_qa_rank_fault_candidates',description:'Ochiai suspiciousness ranking from independently observed line coverage and pass/fail executions. NOT causal proof.',
    parameters:{executionsJson:{type:'string',required:true}},output:jsonOut,
    async execute(args){return bounded(async()=>rankFaultCandidates(JSON.parse(args.executionsJson)));}
  });
  register({
    name:'frontend_qa_compare_algorithms',description:'Run reproducible baseline versus constrained covering-array comparison on bundled SYNTHETIC fault fixtures, equal case budgets. Not a real-project QA benchmark.',
    parameters:{caseBudget:{type:'number'}},output:jsonOut,
    async execute(args){return bounded(async()=>runComparison({budgetOverride:args.caseBudget??null}));}
  });
  register({
    name:'frontend_qa_trace',description:'Trace statically resolved cross-file direct function calls from one file and symbol. Includes exact call sites and unresolved limitations, never claims full runtime dataflow.',
    parameters:{projectRoot:{type:'string',required:true},file:{type:'string',required:true,description:'Relative source file, for example src/state.js'},symbol:{type:'string',required:true,description:'Named function, or <module> for top-level calls'},maxDepth:{type:'number'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      const index=buildSemanticIndex(path.resolve(args.projectRoot));
      return {summary:index.summary,trace:traceCalls(index,{file:args.file,symbol:args.symbol,maxDepth:Math.min(10,Math.max(1,args.maxDepth??6))})};
    });},
  });
  register({
    name:'frontend_qa_start_browser',description:'Start a DSH-controlled real Chromium browser via a custom CDP driver. Defaults to localhost-only. Returns handle for autonomous browser test tools.',
    parameters:{chromium:{type:'string'},width:{type:'number'},height:{type:'number'},allowExternal:{type:'boolean',description:'Explicitly enable external HTTP(S) targets; default false'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      if(sessions.size>=3)throw new Error('Maximum three browser sessions');
      const id=`qa${++sessionCounter}`;const b=new ChromiumDriver({executablePath:args.chromium,width:args.width,height:args.height,allowExternal:args.allowExternal===true});
      await b.start();sessions.set(id,b);return {ok:true,session:id,viewport:b.viewport};
    });},
  });
  register({
    name:'frontend_qa_action',description:'Execute a deterministic browser action in DSH-controlled Chromium: navigate, click, fill, inspect, wait, viewport, assertions, screenshot, or CSS rule trace. Uses a single JSON step object.',
    parameters:{session:{type:'string',required:true},stepJson:{type:'string',required:true,description:'JSON step: {"action":"click","selector":"#submit"} or {"action":"expectText","selector":"#total","equals":"300"}'},outputDir:{type:'string'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      const b=sessions.get(args.session);if(!b)throw new Error('Unknown browser session');
      const step=JSON.parse(args.stepJson);const result=await executeStep(b,step,{outputDir:args.outputDir});return {ok:result?.pass!==false,result,verdict:typeof result?.pass==='boolean'?(result.pass?'PASS':'FAIL'):(result?.pass===null?'UNKNOWN':'OBSERVED')};
    });},
  });
  register({
    name:'frontend_qa_trace_interaction',description:'Observe BEFORE/AFTER DOM, CSS, network and console evidence around one deterministic CDP click/fill/select, then evaluate optional independent read-only assertions. No source line is claimed causal merely from a DOM change.',
    parameters:{session:{type:'string',required:true},acknowledgeDisposableEnvironment:{type:'boolean',required:true},configJson:{type:'string',required:true,description:'JSON: {action:"click",selector:"#save",observeSelectors:["#status"],assertions:[{action:"expectText",selector:"#status",equals:"Saved"}],settleMs:100}'}},output:jsonOut,
    async execute(args){return bounded(async()=>{const b=sessions.get(args.session);if(!b)throw new Error('Unknown session');if(args.acknowledgeDisposableEnvironment!==true)throw new Error('Interaction tracing requires disposable test environment authorization');return traceInteraction(b,JSON.parse(args.configJson));});},
  });
  register({
    name:'frontend_qa_visual_audit',description:'Measure real rendered layout and find element obstruction, overflow, clipping, broken images, and contrast suspects. Attach matching CSS rules when requested. Findings require validation of design intent.',
    parameters:{session:{type:'string',required:true},cssEvidence:{type:'boolean'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      const b=sessions.get(args.session);if(!b)throw new Error('Unknown browser session');const report=await auditVisual(b);
      if(args.cssEvidence)await enrichVisualFindings(b,report.issues);return report;
    });},
  });
  register({
    name:'frontend_qa_explore',description:'Discover visible interactable elements and safely classify their potential side effects; optionally execute bounded, potentially safe clicks in a disposable environment, recording DOM and runtime effects. Observations are UNKNOWN without independent business rules.',
    parameters:{session:{type:'string',required:true},executeSafeClicks:{type:'boolean'},acknowledgeTestEnvironment:{type:'boolean',description:'Required true to execute autonomous clicks: user authorizes disposable environment'},maxActions:{type:'number'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      const b=sessions.get(args.session);if(!b)throw new Error('Unknown browser session');
      if(args.executeSafeClicks&&!args.acknowledgeTestEnvironment)throw new Error('Autonomous clicks require acknowledgeTestEnvironment=true');
      return explorePage(b,{executeSafeClicks:args.executeSafeClicks===true,maxActions:Math.min(50,Math.max(1,args.maxActions||20))});
    });},
  });
  register({
    name:'frontend_qa_close_browser',description:'Close one browser session and destroy its temporary browser profile.',
    parameters:{session:{type:'string',required:true}},output:jsonOut,
    async execute(args){return bounded(async()=>{const b=sessions.get(args.session);if(!b)throw new Error('Unknown session');sessions.delete(args.session);await b.stop();return {ok:true};});},
  });
  register({
    name:'frontend_qa_run_suite',description:'Run complete source scan plus pre-specified real Chromium interactions and visual audit. Creates report.json/report.md in outputDir. Read the independent spec first; unknown expectations must not be treated as pass.',
    parameters:{projectRoot:{type:'string',required:true},specJson:{type:'string',required:true,description:'JSON: {url,steps:[{action,selector,...}],autoVisual:true}'},outputDir:{type:'string'},allowExternal:{type:'boolean'}},output:jsonOut,
    async execute(args){return bounded(async()=>{
      const spec=JSON.parse(args.specJson);const report=await runScenario({...spec,projectRoot:path.resolve(args.projectRoot),outputDir:args.outputDir||spec.outputDir,allowExternal:args.allowExternal===true});
      return {ok:!report.fatalError,summary:report.summary,semanticSummary:report.semantic?.summary,outputs:report.outputs,fatal:report.fatalError||null,tests:report.tests,visualFindings:report.visual?.issues||[],runtimeErrors:report.logs.exceptions};
    });},
  });
  ctx.effect(()=>()=>{for(const b of sessions.values())void b.stop();sessions.clear();});
}
let sessionCounter=0;

// Algorithmic tools are registered by the main apply() function, not module initialization.
