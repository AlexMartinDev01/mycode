import fs from 'node:fs/promises';
import path from 'node:path';
import { ChromiumDriver } from './browser.js';
import { scanProject } from './scanner.js';
import { auditVisual,enrichVisualFindings } from './visual.js';
import { comparePngFiles } from './png.js';
import { correlateFindings } from './diagnostics.js';

const STATUS={PASS:'PASS',FAIL:'FAIL',UNKNOWN:'UNKNOWN',SUSPECT:'SUSPECT',NOT_TESTED:'NOT_TESTED'};
const allowedActions=new Set(['navigate','viewport','click','fill','wait','inspect','expectText','expectValue','expectVisible','expectUrl','expectStyle','expectNumber','visual','screenshot','visualBaseline','css']);
function serial(err){return err instanceof Error?err.message:String(err);}
function validateStep(step){if(!step||!allowedActions.has(step.action))throw new Error(`Unsupported action: ${step?.action}`);if(['click','fill','inspect','expectText','expectValue','expectVisible','expectStyle','expectNumber','css'].includes(step.action)&&typeof step.selector!=='string')throw new Error(`Missing selector for ${step.action}`);}
export async function executeStep(browser,step,{outputDir='',index=0}={}){
  validateStep(step);
  const d=step;
  switch(d.action){
    case 'navigate':return browser.navigate(d.url,{allowExternal:d.allowExternal===true});
    case 'viewport':return browser.setViewport(d.width,d.height);
    case 'click':return browser.click(d.selector);
    case 'fill':return browser.fill(d.selector,d.value??'');
    case 'wait':{
      if(d.selector){await browser.waitFor(`!!document.querySelector(${JSON.stringify(d.selector)})`,Math.min(d.timeoutMs||4000,30000));return {ready:true};}
      await new Promise(r=>setTimeout(r,Math.min(d.ms||100,3000)));return {waited:true};
    }
    case 'inspect':return browser.inspect(d.selector);
    case 'css':return browser.cssFor(d.selector);
    case 'expectText':{
      const actual=await browser.evaluate(`document.querySelector(${JSON.stringify(d.selector)})?.textContent?.trim()??null`);
      const expected=String(d.equals);return {pass:actual===expected,actual,expected};
    }
    case 'expectValue':{
      const actual=await browser.evaluate(`document.querySelector(${JSON.stringify(d.selector)})?.value??null`);
      const expected=String(d.equals);return {pass:actual===expected,actual,expected};
    }
    case 'expectVisible':{
      const value=await browser.inspect(d.selector),actual=!!value?.visible,expected=d.equals!==false;
      return {pass:actual===expected,actual,expected};
    }
    case 'expectUrl':{
      const actual=await browser.evaluate('location.href');const expected=String(d.includes);return {pass:actual.includes(expected),actual,expected};
    }
    case 'expectStyle':{
      const actual=await browser.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(d.selector)})).getPropertyValue(${JSON.stringify(d.property)}).trim()`);
      return {pass:actual===String(d.equals),actual,expected:String(d.equals),property:d.property,cssEvidence:await browser.cssFor(d.selector)};
    }
    case 'expectNumber':{
      const raw=await browser.evaluate(`document.querySelector(${JSON.stringify(d.selector)})?.textContent?.trim()??null`);
      const actual=raw==null?null:Number(String(raw).replace(/[^\d.\-]/g,'')),expected=Number(d.equals),tolerance=Number(d.tolerance??0);
      return {pass:actual!==null&&Number.isFinite(actual)&&Number.isFinite(expected)&&Math.abs(actual-expected)<=tolerance,actual,expected,tolerance};
    }
    case 'visual':{
      const r=await auditVisual(browser);if(d.cssEvidence===true)await enrichVisualFindings(browser,r.issues);
      return r;
    }
    case 'screenshot':{
      const name=`step-${String(index).padStart(3,'0')}.png`;
      return await browser.screenshot(path.join(outputDir||process.cwd(),name));
    }
    case 'visualBaseline':{
      const name=`visual-${String(index).padStart(3,'0')}.png`,actual=path.join(outputDir||process.cwd(),name);
      await browser.screenshot(actual);
      if(!d.baseline)return {pass:null,verdict:'UNKNOWN',reason:'No approved baseline',actual};
      const baseline=path.resolve(d.baseline);
      return {...await comparePngFiles(actual,baseline,{maxChangedRatio:d.maxChangedRatio??0.003,tolerance:d.tolerance??18}),actual,baseline};
    }
  }
}
export async function runScenario({projectRoot,url,steps=[],outputDir,chromium,allowExternal=false,scan=true,autoVisual=true,width=1280,height=800}={}) {
  if(!projectRoot)throw new Error('projectRoot is required');
  const root=path.resolve(projectRoot);
  const out=path.resolve(outputDir||path.join(root,'.dsh-qa-report'));
  if(out===root)throw new Error('Output directory must not be project root');
  await fs.mkdir(out,{recursive:true});
  const startedAt=new Date().toISOString();
  const report={schemaVersion:1,startedAt,projectRoot:root,outputs:out,scan:scan?scanProject(root):null,tests:[],visual:null,logs:{},summary:{pass:0,fail:0,suspect:0,unknown:0},limitations:['Static import graph is not a complete interprocedural call graph.','Visual heuristics cannot establish design intent without an approved baseline.','Precise root-cause line attribution requires independent causal validation and may be unavailable.','Chromium testing does not prove Firefox/Safari compatibility.']};
  const browser=new ChromiumDriver({executablePath:chromium,allowExternal,width,height});
  try {
    await browser.start();
    if(url)await browser.navigate(url,{allowExternal});
    for(let i=0;i<steps.length;i++){
      const step=steps[i],item={index:i,step,status:STATUS.UNKNOWN};
      try {
        const result=await executeStep(browser,step,{outputDir:out,index:i});item.result=result;
        if(typeof result?.pass==='boolean')item.status=result.pass?STATUS.PASS:STATUS.FAIL;
        else if(result?.verdict==='UNKNOWN')item.status=STATUS.UNKNOWN;
        else item.status=STATUS.PASS;
      }catch(e){item.status=STATUS.FAIL;item.error=serial(e);}
      report.tests.push(item);
      if(item.status==='FAIL'&&step.stopOnFailure)break;
    }
    if(autoVisual){report.visual=await auditVisual(browser);await enrichVisualFindings(browser,report.visual.issues);}
    report.logs=structuredClone(browser.logs);
  }catch(e){report.fatalError=serial(e);}finally{await browser.stop();}
  for(const r of report.tests){if(r.status==='PASS')report.summary.pass++;else if(r.status==='FAIL')report.summary.fail++;else report.summary.unknown++;}
  const counts={FAIL:0,SUSPECT:0};for(const issue of report.visual?.issues||[]){if(issue.verdict==='FAIL')counts.FAIL++;else counts.SUSPECT++;}
  report.summary.visualFail=counts.FAIL;report.summary.visualSuspect=counts.SUSPECT;
  report.summary.fatal=!!report.fatalError;
  report.codeCandidates=correlateFindings(report.scan,report);
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'report.md'),formatReport(report));
  return report;
}
export function formatReport(r){
  const rows=[`# DSH Autonomous Frontend QA`, ``, `- Project: \`${r.projectRoot}\``,`- Run: ${r.startedAt}`,`- Assertions pass/fail/unknown: ${r.summary.pass}/${r.summary.fail}/${r.summary.unknown}`,`- Visual findings (fail/suspect): ${r.summary.visualFail}/${r.summary.visualSuspect}`,`- Fatal error: ${r.fatalError||'none'}`,``, `## Source coverage`, ``, `Files parsed: ${r.scan?.summary.parsed??'not scanned'}/${r.scan?.summary.discovered??'not scanned'}; dynamically verified files: not measured`, ``, `## Test steps`, ``, `| # | Action | Selector | Result | Evidence |`,`|---|---|---|---|---|`];
  for(const t of r.tests){rows.push(`| ${t.index} | ${t.step.action} | ${String(t.step.selector||'').replaceAll('|','\\|')} | ${t.status} | ${String(t.error||((t.result?.actual!=null)?`actual=${t.result.actual}, expected=${t.result.expected}`:'')).replaceAll('|','\\|').slice(0,140)} |`);}
  rows.push('','## Visual findings','');
  for(const issue of r.visual?.issues||[])rows.push(`- **${issue.verdict}** ${issue.type} on \`${issue.selector}\`: ${JSON.stringify(issue.detail)}${issue.cssEvidence?.rules?.[0]?.url?` (style: ${issue.cssEvidence.rules[0].url})`:''}`);
  rows.push('','## Code location candidates (unconfirmed)','');
  for(const f of r.codeCandidates?.functional||[])rows.push(`- Functional test ${f.testIndex}: ${f.candidates.map(c=>c.file+':'+c.line).join(', ')||'no source candidate'} — **not confirmed root cause**`);
  for(const v of r.codeCandidates?.visual||[])if(v.candidates.length)rows.push(`- Visual ${v.issue} (${v.selector}): ${v.candidates.map(c=>c.file+':'+c.line).join(', ')} — **not confirmed root cause**`);
  rows.push('','## Runtime errors','');for(const e of r.logs?.exceptions||[])rows.push(`- ${e.text} (${e.url||'?'}:${e.line??'?'})`);
  rows.push('','## Proven limitations','');for(const l of r.limitations)rows.push(`- ${l}`);
  return rows.join('\n')+'\n';
}
