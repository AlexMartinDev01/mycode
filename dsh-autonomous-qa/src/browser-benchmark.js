/** Real Chromium A/B smoke. Synthetic fault-injected page, independent status contract. */
import {ChromiumDriver} from './browser.js';
import {runCombinationCases} from './combination-runtime.js';
import {buildMarkupIndex,planTagCombinations} from './markup.js';
import {planConstrainedCoveringGroup} from './algorithms.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fixtures} from '../bench/fixtures.js';
const match=(state,pattern)=>Object.entries(pattern).every(([k,v])=>state[k]===v);
function renderFixture(fixture){
  const controls=fixture.controls.map(([id,type])=>type==='button'?`<button type="button" id="${id}">${id}</button>`:`<input type="${type}" id="${id}"/>`).join('\n');
  const script=`(()=>{
    const defs=${JSON.stringify(fixture.controls)};const faults=${JSON.stringify(fixture.faults)};let clicked={};
    function state(){const s={};for(const [id,type] of defs){const el=document.getElementById(id);const v=el.value;
      if(type==='button')s['#'+id]=clicked[id]?'activate':'idle';
      else if(type==='checkbox')s['#'+id]=el.checked?'checked':'unchecked';
      else if(type==='number')s['#'+id]=!v?'empty':Number(v)===0?'zero':Number(v)<0?'negative':'positive';
      else if(type==='email')s['#'+id]=!v?'empty':v==='qa@example.test'?'valid':'invalid';
      else s['#'+id]=!v?'empty':v.length>=64?'boundary':'typical';
    }return s;}
    function redraw(){const s=state();const failures=faults.filter(f=>Object.entries(f.when).every(([k,v])=>s[k]===v));document.getElementById('status').textContent=failures.length?'BUG':'OK';}
    for(const [id,type] of defs){let el=document.getElementById(id);
      if(type==='button')el.addEventListener('click',()=>{clicked[id]=true;redraw();});
      else {el.addEventListener('input',redraw);el.addEventListener('change',redraw);}
    }
    redraw();
  })();`;
  return `<!doctype html><html><body><form>${controls}</form><output id="status">OK</output><script>${script}</script></body></html>`;
}
export async function runBrowserComparison({fixtureId='signup',budget=12}={}){
  const fixture=fixtures.find(x=>x.id===fixtureId);if(!fixture)throw new Error('Unknown benchmark fixture');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-browser-ab-'));
  const browser=new ChromiumDriver();
  try{
    const file=path.join(dir,'scenario.html');await fs.writeFile(file,`<form>${fixture.controls.map(([id,type])=>type==='button'?`<button id="${id}">${id}</button>`:`<input id="${id}" type="${type}"/>`).join('')}</form>`);
    const markup=buildMarkupIndex(dir),baseline=planTagCombinations(markup,{maxCases:budget}).groups[0];
    const algorithm=planConstrainedCoveringGroup(baseline,{maxCases:budget,constraints:fixture.constraints,seed:17});
    const html=renderFixture(fixture),rules=[{when:{},assertions:[{action:'expectText',selector:'#status',equals:'OK'}]}];
    await browser.start();
    const reset=async b=>{const frameId=(await b.cdp.command('Page.getFrameTree')).frameTree.frame.id;await b.cdp.command('Page.setDocumentContent',{frameId,html});};
    async function run(group){
      const valid=group.scenarios.filter(s=>!fixture.constraints.some(c=>match(Object.fromEntries(s.assignments.map(a=>[a.selector,a.state])),c.when)));
      const start=performance.now();
      const result=await runCombinationCases(browser,{...group,scenarios:valid},{reset,rules,acknowledgeDisposableEnvironment:true,maxCases:64});
      const actualById=new Map(result.cases.map(c=>[c.id,c]));const seen=new Set();let incorrect=0;
      for(const scenario of valid){
        const state=Object.fromEntries(scenario.assignments.map(a=>[a.selector,a.state]));
        const expectedFail=fixture.faults.filter(f=>match(state,f.when));const actual=actualById.get(scenario.id);
        if((actual?.status==='FAIL')!==Boolean(expectedFail.length))incorrect++;
        if(actual?.status==='FAIL')for(const f of expectedFail)seen.add(f.id);
      }
      return {budget,planned:group.scenarios.length,executed:result.summary.executed,invalidSkipped:group.scenarios.length-valid.length,failedAssertions:result.summary.failed,unknown:result.summary.unknown,suspect:result.summary.suspect,observedFaults:[...seen].sort(),observedFaultCount:seen.size,oracleDisagreements:incorrect,elapsedMs:performance.now()-start};
    }
    return {fixture:fixtureId,kind:'real-Chromium-in-memory-synthetic-defect',baseline:await run(baseline),algorithm:await run(algorithm),totalInjectedFaults:fixture.faults.length,limitations:['Synthetic fault triggers, not natural production defects.','Browser test uses CDP Page.setDocumentContent; real site navigation and DSH host loading are not verified.','Constraints are provided to the algorithm, while legacy baseline lacks constraint handling.']};
  }finally{await browser.stop();await fs.rm(dir,{recursive:true,force:true});}
}
