import { defineTool } from '@deepseek-ai/dsh-tools';
import path from 'node:path';
import { scanProject } from './scanner.js';
import { ChromiumDriver } from './browser.js';
import { executeStep,runScenario } from './engine.js';
import { auditVisual,enrichVisualFindings } from './visual.js';
import { explorePage } from './explorer.js';

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
    async execute(args){return bounded(async()=>scanProject(path.resolve(args.projectRoot)));},
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
      const step=JSON.parse(args.stepJson);const result=await executeStep(b,step,{outputDir:args.outputDir});return {ok:true,result};
    });},
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
      return {ok:!report.fatalError,summary:report.summary,outputs:report.outputs,fatal:report.fatalError||null,tests:report.tests,visualFindings:report.visual?.issues||[],runtimeErrors:report.logs.exceptions};
    });},
  });
  ctx.effect(()=>()=>{for(const b of sessions.values())void b.stop();sessions.clear();});
}
let sessionCounter=0;
