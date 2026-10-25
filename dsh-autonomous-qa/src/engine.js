import fs from 'node:fs/promises';
import path from 'node:path';
import { ChromiumDriver } from './browser.js';
import { scanProject } from './scanner.js';
import { buildSemanticIndex } from './semantic.js';
import { auditVisual,enrichVisualFindings } from './visual.js';
import { comparePngFiles } from './png.js';
import { correlateFindings } from './diagnostics.js';
import { buildMarkupIndex,planTagCombinations } from './markup.js';

const STATUS={PASS:'PASS',FAIL:'FAIL',UNKNOWN:'UNKNOWN',SUSPECT:'SUSPECT',NOT_TESTED:'NOT_TESTED'};
const allowedActions=new Set(['navigate','viewport','click','fill','wait','inspect','expectText','expectValue','expectVisible','expectUrl','expectStyle','expectNumber','expectDerived','expectAttribute','expectCount','expectNetwork','expectLayout','expectEventually','selectOption','visual','screenshot','visualBaseline','css']);
function serial(err){return err instanceof Error?err.message:String(err);}
function validateStep(step){if(!step||!allowedActions.has(step.action))throw new Error(`Unsupported action: ${step?.action}`);if(['click','fill','inspect','expectText','expectValue','expectVisible','expectStyle','expectNumber','expectDerived','expectAttribute','expectCount','expectLayout','selectOption','css'].includes(step.action)&&typeof step.selector!=='string')throw new Error(`Missing selector for ${step.action}`);}
export async function executeStep(browser,step,{outputDir='',index=0}={}){
  validateStep(step);
  const d=step;
  switch(d.action){
    case 'navigate':return browser.navigate(d.url,{allowExternal:browser.options?.allowExternal===true&&d.allowExternal===true});
    case 'viewport':return browser.setViewport(d.width,d.height);
    case 'click':return browser.click(d.selector);
    case 'fill':return browser.fill(d.selector,d.value??'');
    case 'selectOption':return browser.selectOption(d.selector,d.value);
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
    case 'expectDerived':{
      // Oracle originates from an independent scenario contract, not the application's implementation.
      if(!Array.isArray(d.inputs)||d.inputs.length<1||d.inputs.length>12)throw new Error('expectDerived requires 1..12 inputs');
      const allowedOps=new Set(['add','subtract','multiply','divide','min','max']);
      if(!allowedOps.has(d.operation))throw new Error('Unsupported independent oracle operation');
      const rawInputs=await Promise.all(d.inputs.map(async input=>{
        if(typeof input?.selector!=='string')throw new Error('Invalid input selector');
        const raw=await browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(input.selector)});return n?((${JSON.stringify(input.from||'value')}==='text')?n.textContent:n.value):null;})()`);
        const n=Number(String(raw??'').replace(/[^\d.\-]/g,''));
        return {selector:input.selector,raw,number:raw!==null&&String(raw).trim()!==''&&Number.isFinite(n)?n:null};
      }));
      if(rawInputs.some(x=>x.number===null))return {pass:null,verdict:'UNKNOWN',reason:'Input missing or nonnumeric',inputs:rawInputs};
      const nums=rawInputs.map(x=>x.number);
      let expected;
      if(d.operation==='add')expected=nums.reduce((a,b)=>a+b,0);
      if(d.operation==='subtract')expected=nums.slice(1).reduce((a,b)=>a-b,nums[0]);
      if(d.operation==='multiply')expected=nums.reduce((a,b)=>a*b,1);
      if(d.operation==='divide')expected=nums.slice(1).reduce((a,b)=>a/b,nums[0]);
      if(d.operation==='min')expected=Math.min(...nums);
      if(d.operation==='max')expected=Math.max(...nums);
      if(!Number.isFinite(expected))return {pass:null,verdict:'UNKNOWN',reason:'Non-finite expected value',inputs:rawInputs};
      if(Number.isFinite(d.offset))expected+=d.offset;
      if(Number.isFinite(d.factor))expected*=d.factor;
      const raw=await browser.evaluate(`document.querySelector(${JSON.stringify(d.selector)})?.textContent??null`);
      const actual=raw==null?null:Number(String(raw).replace(/[^\d.\-]/g,''));
      const tolerance=Number(d.tolerance??0);
      return {pass:actual!==null&&Number.isFinite(actual)&&Math.abs(actual-expected)<=tolerance,actual,expected,tolerance,inputs:rawInputs,oracle:{operation:d.operation,origin:'scenario-contract'}};
    }
    case 'expectAttribute':{
      if(typeof d.attribute!=='string'||!/^[\w:-]{1,100}$/.test(d.attribute))throw new Error('Invalid attribute name');
      const actual=await browser.evaluate(`document.querySelector(${JSON.stringify(d.selector)})?.getAttribute(${JSON.stringify(d.attribute)})??null`);
      return {pass:actual===(d.equals??null),actual,expected:d.equals??null,attribute:d.attribute};
    }
    case 'expectCount':{
      const actual=await browser.evaluate(`document.querySelectorAll(${JSON.stringify(d.selector)}).length`),expected=Number(d.equals);
      return {pass:actual===expected,actual,expected};
    }
    case 'expectLayout':{
      // Declarative design contract, not model subjective aesthetics.
      const outcome=await browser.evaluate(`(()=>{
        const node=document.querySelector(${JSON.stringify(d.selector)});
        if(!node)return {verdict:'UNKNOWN',pass:null,reason:'Layout target missing'};
        const r=node.getBoundingClientRect();const view={width:document.documentElement.clientWidth,height:document.documentElement.clientHeight};
        const otherSelector=${JSON.stringify(d.relativeTo??null)};
        const other=otherSelector?document.querySelector(otherSelector):null;
        const q=other?.getBoundingClientRect();
        return {rect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},viewport:view,relativeRect:q?{x:q.x,y:q.y,width:q.width,height:q.height,right:q.right,bottom:q.bottom}:null};
      })()`);
      if(outcome.pass===null)return outcome;
      const failures=[],r=outcome.rect,v=outcome.viewport,q=outcome.relativeRect,tol=Number(d.tolerance??2);
      if(d.insideViewport===true && (r.x< -tol||r.y< -tol||r.right>v.width+tol||r.bottom>v.height+tol))failures.push('outside-viewport');
      for(const [field,bound,key] of [['width','minWidth','min'],['height','minHeight','min'],['width','maxWidth','max'],['height','maxHeight','max']]){
        if(d[bound]!==undefined&&(!Number.isFinite(Number(d[bound]))||(key==='min'?r[field]<Number(d[bound])-tol:r[field]>Number(d[bound])+tol)))failures.push(bound);
      }
      if(d.relativeTo!==undefined&&!q) return {pass:null,verdict:'UNKNOWN',reason:'Related element missing',...outcome};
      if(q && d.mustNotOverlap===true){
        const w=Math.min(r.right,q.right)-Math.max(r.x,q.x),h=Math.min(r.bottom,q.bottom)-Math.max(r.y,q.y);
        if(w>tol&&h>tol)failures.push('overlap');
      }
      if(q && d.align==='left' && Math.abs(r.x-q.x)>tol)failures.push('left-misaligned');
      if(q && d.align==='center-x' && Math.abs((r.x+r.width/2)-(q.x+q.width/2))>tol)failures.push('center-misaligned');
      const pass=failures.length===0;
      return {pass,failures,...outcome,cssEvidence:pass?undefined:await browser.cssFor(d.selector),oracle:{origin:'scenario-layout-contract'}};
    }
    case 'expectEventually':{
      const check=d.assertion;
      const safe=new Set(['expectText','expectValue','expectVisible','expectUrl','expectNumber','expectDerived','expectAttribute','expectCount','expectStyle','expectLayout','expectNetwork']);
      if(!check||!safe.has(check.action))throw new Error('expectEventually requires a read-only assertion');
      const timeout=Math.max(100,Math.min(10000,Number(d.timeoutMs??3000)));
      const interval=Math.max(30,Math.min(500,Number(d.intervalMs??70)));
      // Avoid stale-state false PASS: require assertion to remain true for a stability window.
      const stableForMs=Math.max(0,Math.min(1500,Number(d.stableForMs??150)));
      const started=Date.now();let stableSince=null,last,wasStable=false,attempts=0;
      do{
        last=await executeStep(browser,check,{outputDir,index});attempts++;
        let settled=true;
        if(d.settleWhen){
          if(typeof d.settleWhen.selector!=='string')throw new Error('settleWhen.selector required');
          const target=await browser.inspect(d.settleWhen.selector);
          settled=!!target?.visible===(d.settleWhen.visible!==false);
        }
        if(last?.pass===true&&settled){if(stableSince===null)stableSince=Date.now();if(Date.now()-stableSince>=stableForMs){wasStable=true;break;}}
        else stableSince=null;
        if(Date.now()-started>=timeout)break;
        await new Promise(resolve=>setTimeout(resolve,interval));
      }while(true);
      if(wasStable)return {pass:true,attempted:last,elapsedMs:Date.now()-started,stableForMs,attempts};
      return {pass:last?.pass===null?null:false,verdict:last?.pass===null?'UNKNOWN':'FAIL',attempted:last,reason:'Timed out waiting for stable assertion and settle condition',elapsedMs:Date.now()-started,stableForMs,attempts};
    }
    case 'expectNetwork':{
      if(!d.urlIncludes||typeof d.urlIncludes!=='string')throw new Error('expectNetwork requires urlIncludes');
      const candidates=(browser.logs.network||[]).filter(n=>n.url?.includes(d.urlIncludes)&&n.method==='RESPONSE');
      const match=candidates.find(n=>(d.status===undefined||n.status===Number(d.status))&&(d.httpMethod===undefined||n.httpMethod===d.httpMethod));
      const expected={urlIncludes:d.urlIncludes,status:d.status??null,httpMethod:d.httpMethod??null};
      return {pass:!!match,actual:match||null,expected,observedRequests:candidates.length};
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
export async function runScenario({projectRoot,url,steps=[],outputDir,chromium,allowExternal=false,scan=true,autoVisual=true,width=1280,height=800,viewports=[],prepareBrowser=null}={}) {
  if(!projectRoot)throw new Error('projectRoot is required');
  const root=path.resolve(projectRoot);
  const out=path.resolve(outputDir||path.join(root,'.dsh-qa-report'));
  if(out===root)throw new Error('Output directory must not be project root');
  await fs.mkdir(out,{recursive:true});
  const startedAt=new Date().toISOString();
  const report={schemaVersion:1,startedAt,projectRoot:root,outputs:out,scan:scan?scanProject(root):null,semantic:scan?buildSemanticIndex(root):null,markup:scan?buildMarkupIndex(root):null,interactionPlan:null,tests:[],visual:null,visualByViewport:[],logs:{},summary:{pass:0,fail:0,suspect:0,unknown:0},limitations:['Static import graph is not a complete interprocedural call graph.','Visual heuristics cannot establish design intent without an approved baseline.','Precise root-cause line attribution requires independent causal validation and may be unavailable.','Chromium testing does not prove Firefox/Safari compatibility.']};
  if(report.markup)report.interactionPlan=planTagCombinations(report.markup,{maxCases:16});
  const browser=new ChromiumDriver({executablePath:chromium,allowExternal,width,height});
  try {
    await browser.start();
    // Test harness can initialize an in-memory fixture without bypassing browser input/CDP.
    // Not serializable from a JSON spec or exposed by the DSH plugin.
    if(prepareBrowser!==null){if(typeof prepareBrowser!=='function')throw new Error('Invalid prepareBrowser hook');await prepareBrowser(browser);}
    if(url)await browser.navigate(url,{allowExternal});
    for(let i=0;i<steps.length;i++){
      const step=steps[i],item={index:i,step,status:STATUS.UNKNOWN};
      try {
        const result=await executeStep(browser,step,{outputDir:out,index:i});item.result=result;
        if(typeof result?.pass==='boolean')item.status=result.pass?STATUS.PASS:STATUS.FAIL;
        else if(result?.pass===null||result?.verdict==='UNKNOWN')item.status=STATUS.UNKNOWN;
        else if(step.action==='visual' && result?.issues?.length)item.status=STATUS.SUSPECT;
        else if((step.action==='inspect' && !result)||(step.action==='css' && !result?.matched))item.status=STATUS.UNKNOWN;
        else item.status=STATUS.PASS;
      }catch(e){item.status=STATUS.FAIL;item.error=serial(e);}
      report.tests.push(item);
      if(item.status==='FAIL'&&step.stopOnFailure)break;
    }
    if(autoVisual){report.visual=await auditVisual(browser);await enrichVisualFindings(browser,report.visual.issues);}
    for(const vp of viewports.slice(0,12)){
      try{
        const width=Number(vp.width),height=Number(vp.height||800);
        await browser.setViewport(width,height);
        const audit=await auditVisual(browser);
        report.visualByViewport.push({width,height,audit});
      }catch(e){report.visualByViewport.push({width:vp.width,height:vp.height,error:serial(e)});}
    }
    report.logs=structuredClone(browser.logs);
  }catch(e){report.fatalError=serial(e);}finally{await browser.stop();}
  for(const r of report.tests){if(r.status==='PASS')report.summary.pass++;else if(r.status==='FAIL')report.summary.fail++;else if(r.status==='SUSPECT')report.summary.suspect++;else report.summary.unknown++;}
  const counts={FAIL:0,SUSPECT:0};for(const issue of report.visual?.issues||[]){if(issue.verdict==='FAIL')counts.FAIL++;else counts.SUSPECT++;}
  for(const v of report.visualByViewport){for(const i of v.audit?.issues||[]){if(i.verdict==='FAIL')counts.FAIL++;else counts.SUSPECT++;}}
  report.summary.visualFail=counts.FAIL;report.summary.visualSuspect=counts.SUSPECT;
  report.summary.fatal=!!report.fatalError;
  report.runtimeFindings=[...(report.logs.exceptions||[]).map(e=>({type:'javascript-exception',verdict:'SUSPECT',detail:e})),...(report.logs.network||[]).filter(e=>e.status>=500||e.method==='FAILED').map(e=>({type:'network-failure',verdict:'SUSPECT',detail:e}))];
  report.codeCandidates=correlateFindings(report.scan,report);
  report.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'report.md'),formatReport(report));
  return report;
}
export function formatReport(r){
  const rows=[`# DSH Autonomous Frontend QA`, ``, `- Project: \`${r.projectRoot}\``,`- Run: ${r.startedAt}`,`- Assertions pass/fail/suspect/unknown: ${r.summary.pass}/${r.summary.fail}/${r.summary.suspect}/${r.summary.unknown}`,`- Visual findings (fail/suspect): ${r.summary.visualFail}/${r.summary.visualSuspect}`,`- Fatal error: ${r.fatalError||'none'}`,``, `## Source coverage`, ``, `Files parsed: ${r.scan?.summary.parsed??'not scanned'}/${r.scan?.summary.discovered??'not scanned'}; statically resolved calls: ${r.semantic?.summary.resolvedCalls??'not analyzed'}; markup tags: ${r.markup?.summary.tags??'not analyzed'}; proposed tag-state cases: ${r.interactionPlan?.summary.scenarios??'not planned'} (NOT_TESTED unless independently executed); dynamically verified files: not measured`, ``, `## Test steps`, ``, `| # | Action | Selector | Result | Evidence |`,`|---|---|---|---|---|`];
  for(const t of r.tests){rows.push(`| ${t.index} | ${t.step.action} | ${String(t.step.selector||'').replaceAll('|','\\|')} | ${t.status} | ${String(t.error||((t.result?.actual!=null)?`actual=${t.result.actual}, expected=${t.result.expected}`:'')).replaceAll('|','\\|').slice(0,140)} |`);}
  rows.push('','## Visual findings','');
  for(const issue of r.visual?.issues||[])rows.push(`- **${issue.verdict}** ${issue.type} on \`${issue.selector}\`: ${JSON.stringify(issue.detail)}${issue.cssEvidence?.rules?.[0]?.url?` (style: ${issue.cssEvidence.rules[0].url})`:''}`);
  rows.push('','## Responsive viewport matrix','');
  for(const v of r.visualByViewport||[])rows.push(`- ${v.width}×${v.height}: ${v.error||((v.audit?.issues||[]).length+' visual candidate findings')}`);
  rows.push('','## Code location candidates (unconfirmed)','');
  for(const f of r.codeCandidates?.functional||[])rows.push(`- Functional test ${f.testIndex}: ${f.candidates.map(c=>c.file+':'+c.line).join(', ')||'no source candidate'} — **not confirmed root cause**`);
  for(const v of r.codeCandidates?.visual||[])if(v.candidates.length)rows.push(`- Visual ${v.issue} (${v.selector}): ${v.candidates.map(c=>c.file+':'+c.line).join(', ')} — **not confirmed root cause**`);
  rows.push('','## Runtime errors','');for(const e of r.logs?.exceptions||[])rows.push(`- ${e.text} (${e.url||'?'}:${e.line??'?'})`);
  rows.push('','## Proven limitations','');for(const l of r.limitations)rows.push(`- ${l}`);
  return rows.join('\n')+'\n';
}
