import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChromiumDriver} from '../src/browser.js';
import {executeStep,runScenario} from '../src/engine.js';
import {runCombinationCases} from '../src/combination-runtime.js';
import {auditVisual} from '../src/visual.js';
import {planConstrainedCoveringGroup,rankFaultCandidates,minimizeFailingSequence,planModelTransitions} from '../src/algorithms.js';
const fixture=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../fixtures/buggy-app');
async function documentContent(browser,html){const frame=(await browser.cdp.command('Page.getFrameTree')).frameTree.frame.id;await browser.cdp.command('Page.setDocumentContent',{frameId:frame,html:'<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'+html+'</body></html>'});}
const checkout=`<style>body{font:16px Arial}#checkout{width:320px}#block{display:none}@media(max-width:500px){.bad-responsive{min-width:650px}}</style>
<section id="checkout" class="bad-responsive"><input id="price" type="number" value="10"><input id="qty" type="number" value="2"><select id="rate"><option value="1">Full</option><option value="0.5">Half</option></select><button id="buy">Calculate</button><span id="total">0</span><span id="loading" hidden>Loading</span></section>
<div id="block" style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:100;background:rgba(0,0,0,.2)"></div>
<script>window.__broken=false;window.__operations=0;document.querySelector('#buy').addEventListener('click',()=>{const p=+document.querySelector('#price').value,q=+document.querySelector('#qty').value,r=+document.querySelector('#rate').value;window.__operations++;document.querySelector('#loading').hidden=false;setTimeout(()=>{document.querySelector('#total').textContent=window.__broken?(p+q)*r:p*q*r;document.querySelector('#loading').hidden=true},45)})</script>`;
async function createCheckout(b){await documentContent(b,checkout);}

test('native CDP keyboard selection fires real change event',async()=>{
 const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<select id="s"><option value="">None</option><option value="a">Alpha</option><option value="b">Beta</option></select><span id="out"></span><script>document.querySelector('#s').addEventListener('change',e=>document.querySelector('#out').textContent=e.target.value)</script>`);
 const a=await b.selectOption('#s','b');assert.equal(a.pass,true);assert.equal(a.trustedKeyboard,true);assert.equal((await b.inspect('#out')).text,'b');
 }finally{await b.stop()}
});

test('real Chromium CDP async oracle compares business rule, detects injected mutation, then recovers',async()=>{
 const b=new ChromiumDriver();try{await b.start();await createCheckout(b);
  for(const [price,qty,rate,broken] of [[10,2,'1',false],[14,3,'0.5',false],[10,2,'1',true],[8,4,'0.5',true],[8,4,'0.5',false]]){
   await b.fill('#price',price);await b.fill('#qty',qty);assert.equal((await b.selectOption('#rate',rate)).pass,true);await b.evaluate(`window.__broken=${JSON.stringify(broken)}`);
   await b.click('#buy');const r=await executeStep(b,{action:'expectEventually',timeoutMs:1800,assertion:{action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#price'},{selector:'#qty'},{selector:'#rate'}]}});
   assert.equal(r.pass,!broken,JSON.stringify({price,qty,rate,broken,r}));
  }
 }finally{await b.stop()}
});

test('network observer blocks external embedded resources in isolated document, tracks denial',async()=>{
 const b=new ChromiumDriver();try{await b.start();await documentContent(b,'<img src="https://example.com/not-allowed.png" id="remote">');await new Promise(r=>setTimeout(r,250));
   const blocked=b.logs.network.filter(e=>e.method==='BLOCKED');assert.ok(blocked.length>0,JSON.stringify(b.logs.network));assert.ok(blocked.every(x=>x.url.includes('example.com')));
 }finally{await b.stop()}
});

test('click considers visible target points when center is masked, and rejects fully obstructed/disabled controls',async()=>{
 const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<button id="button" style="width:200px;height:80px;position:relative">Buy</button><div id="mask" style="position:absolute;left:80px;top:20px;width:45px;height:50px;background:black"></div><button id="disabled" disabled>disabled</button><span id="counter">0</span><script>document.querySelector('#button').addEventListener('click',()=>document.querySelector('#counter').textContent=+document.querySelector('#counter').textContent+1)</script>`);
  assert.equal((await b.click('#button')).clicked,true);assert.equal((await b.inspect('#counter')).text,'1');
  await assert.rejects(()=>b.click('#disabled'),/hidden or disabled/);
  await b.evaluate(`document.querySelector('#mask').style.cssText='position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.1)'`);
  await assert.rejects(()=>b.click('#button'),/obstructed/);
 }finally{await b.stop()}
});

test('visual audit distinguishes narrow-screen overflow and real overlay obstruction',async()=>{
 const b=new ChromiumDriver();try{await b.start();await createCheckout(b);
  await b.setViewport(900,700);const wide=await auditVisual(b);assert.equal(wide.issues.some(x=>x.type==='horizontal-overflow'),false);
  await b.setViewport(380,700);const mobile=await auditVisual(b);assert.equal(mobile.issues.some(x=>x.type==='horizontal-overflow'),true);
  await b.evaluate(`document.querySelector('#block').style.display='block'`);const over=await auditVisual(b);assert.ok(over.issues.some(x=>x.type==='interactive-obstructed'));
 }finally{await b.stop()}
});

test('individual combination cases cannot read a preceding case network event',async()=>{
 const b=new ChromiumDriver();try{await b.start();const group={group:'fixture',totalPairs:0,coveredPairs:0,scenarios:[
  {id:'first',assignments:[{selector:'#toggle',state:'idle',kind:'action',value:'not-triggered'}]},
  {id:'second',assignments:[{selector:'#toggle',state:'activate',kind:'action',value:'activate'}]}
 ]};
 let count=0;
 const cases=await runCombinationCases(b,group,{reset:async browser=>{count++;await documentContent(browser,`<button id="toggle">Toggle</button>`);if(count===1)browser.logs.network.push({url:'http://localhost/api/private',method:'RESPONSE',status:200});},acknowledgeDisposableEnvironment:true,rules:[
  {when:{'#toggle':'idle'},assertions:[{action:'expectNetwork',urlIncludes:'/api/private',status:200}]},
  {when:{'#toggle':'activate'},assertions:[{action:'expectNetwork',urlIncludes:'/api/private',status:200}]}
 ]});
 assert.equal(cases.cases[0].status,'PASS');assert.equal(cases.cases[1].status,'FAIL',JSON.stringify(cases));
 }finally{await b.stop()}
});

test('read-only eventual assertions reject command injection, accept harmless async DOM change',async()=>{
 const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<span id="result">pending</span><script>setTimeout(()=>document.querySelector('#result').textContent='done',75)</script>`);
  await assert.rejects(()=>executeStep(b,{action:'expectEventually',assertion:{action:'navigate',url:'http://localhost'}}),/read-only/);
  const r=await executeStep(b,{action:'expectEventually',timeoutMs:1500,assertion:{action:'expectText',selector:'#result',equals:'done'}});assert.equal(r.pass,true);
 }finally{await b.stop()}
});

test('complete source+CDP+responsive workflow produces replayable mixed PASS/FAIL report',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-e2e-hard-'));try{
  const r=await runScenario({projectRoot:fixture,outputDir:tmp,autoVisual:true,viewports:[{width:380,height:700},{width:900,height:700}],prepareBrowser:createCheckout,steps:[
   {action:'fill',selector:'#price',value:10},{action:'fill',selector:'#qty',value:2},{action:'click',selector:'#buy'},
   {action:'expectEventually',timeoutMs:1500,assertion:{action:'expectNumber',selector:'#total',equals:20}},
   {action:'expectNumber',selector:'#total',equals:999},
   {action:'expectLayout',selector:'#checkout',minWidth:300},
  ]});
  assert.equal(r.summary.fatal,false,JSON.stringify(r.fatalError));assert.equal(r.summary.fail,1);assert.equal(r.summary.pass,5);
  assert.equal(r.visualByViewport.length,2);assert.ok(r.visualByViewport[0].audit.issues.some(x=>x.type==='horizontal-overflow'));
  assert.equal(JSON.parse(await fs.readFile(path.join(tmp,'report.json'),'utf8')).summary.fail,1);
  assert.match(await fs.readFile(path.join(tmp,'report.md'),'utf8'),/Code location candidates/);
 }finally{await fs.rm(tmp,{recursive:true,force:true})}
});

test('constrained pairwise algorithm returns valid unique assignments across 120 seeded combinations',()=>{
 let generated=0,coverage=0,total=0;
 for(let seed=1;seed<=120;seed++){
  const factors=Array.from({length:3+(seed%4)},(_,i)=>({node:'n'+i,selector:'#f'+i,kind:'input',file:'ui.ts',line:i+1,levels:Array.from({length:2+((seed+i)%2)},(_,j)=>({id:'s'+j,value:j})),risk:1+i%2}));
  const g={group:'suite',totalPairs:factors.reduce((s,f,i)=>s+factors.slice(i+1).reduce((x,q)=>x+f.levels.length*q.levels.length,0),0),factorDefinitions:factors};
  const constraints=[{when:{'#f0':'s0','#f1':'s0'}}];
  const plan=planConstrainedCoveringGroup(g,{maxCases:16,constraints,seed});const keys=new Set();
  for(const c of plan.scenarios){const values=Object.fromEntries(c.assignments.map(a=>[a.selector,a.state]));assert.ok(values['#f0']!=='s0'||values['#f1']!=='s0');const key=c.assignments.map(a=>a.state).join(',');assert.equal(keys.has(key),false);keys.add(key);}
  assert.equal(plan.coveredPairs+plan.uncoveredPairs,plan.totalPairs);generated+=plan.scenarios.length;coverage+=plan.coveredPairs;total+=plan.totalPairs;
 }
 assert.ok(generated>500);assert.ok(coverage/total>0.7,{coverage,total});
});

test('fault ranking does not claim root cause and keeps zero-failure ranks zero',()=>{
 const z=rankFaultCandidates([{failed:false,coveredLines:['a:1']},{failed:false,coveredLines:['a:1','b:2']}]);assert.equal(z[0].score,0);assert.ok(z.every(x=>x.rootCauseStatus==='NOT_CONFIRMED'));
 const ranked=rankFaultCandidates([{failed:true,coveredLines:['a:1','b:2']},{failed:true,coveredLines:['a:1']},{failed:false,coveredLines:['b:2']}]);assert.equal(ranked[0].location,'a:1');
});

test('ddmin preserves a required two-step failure with distracting operations',async()=>{
 const original=['scroll','fill','switch-theme','click','pause','inspect','noop','upload'],must=new Set(['fill','click']);
 const r=await minimizeFailingSequence(original,async x=>[...must].every(v=>x.includes(v)),{maxTrials:80});
 assert.equal(r.status,'MINIMIZED');assert.deepEqual(r.sequence,['fill','click']);assert.ok(r.trials<80);
});

test('state planner respects bounded transition coverage and reports disconnected transitions',()=>{
 const model={initial:'empty',transitions:[{from:'empty',to:'filled',action:'fill'},{from:'filled',to:'loading',action:'submit'},{from:'loading',to:'done',action:'success'},{from:'unreachable',to:'error',action:'invalid'}]};const res=planModelTransitions(model,{maxDepth:5});assert.equal(res.coveredTransitions,3);assert.equal(res.totalTransitions,4);assert.equal(res.transitionCoverage,.75);
});

test('traceInteraction records before/after state, network observations, and independent oracle',async()=>{
 const {traceInteraction}=await import('../src/interaction.js');
 const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<button id="buy">Buy</button><span id="value">0</span><script>document.querySelector('#buy').addEventListener('click',()=>document.querySelector('#value').textContent='7')</script>`);
 const r=await traceInteraction(b,{action:'click',selector:'#buy',observeSelectors:['#value'],assertions:[{action:'expectNumber',selector:'#value',equals:7}]});
 assert.equal(r.verdict,'PASS');assert.ok(r.changed.includes('#value'));assert.equal(r.before.nodes['#value'].text,'0');assert.equal(r.after.nodes['#value'].text,'7');
 const bad=await traceInteraction(b,{action:'click',selector:'#buy',observeSelectors:['#value'],assertions:[{action:'expectNumber',selector:'#value',equals:99}]});assert.equal(bad.verdict,'FAIL');
 }finally{await b.stop()}
});

test('interaction snapshots redact password and sensitive payment fields',async()=>{
 const {captureInteractionState}=await import('../src/interaction.js');const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<input id="password" type="password" value="do-not-leak"><input id="card" autocomplete="cc-number" value="4111111111111111"><input id="plain" value="public">`);
 const r=await captureInteractionState(b,['#password','#card','#plain']);assert.equal(r.nodes['#password'].value,'[REDACTED]');assert.equal(r.nodes['#card'].value,'[REDACTED]');assert.equal(r.nodes['#plain'].value,'public');assert.equal(JSON.stringify(r).includes('do-not-leak'),false);
 }finally{await b.stop()}
});

test('traceInteraction rejects nested navigation in read-only assertions',async()=>{
 const {traceInteraction}=await import('../src/interaction.js');const b=new ChromiumDriver();try{await b.start();await documentContent(b,`<button id="b">B</button>`);
 await assert.rejects(()=>traceInteraction(b,{action:'click',selector:'#b',assertions:[{action:'expectEventually',assertion:{action:'navigate',url:'https://example.com'}}]}),/read-only/);
 }finally{await b.stop()}
});

test('real combination test supports select elements via CDP keyboard with contract',async()=>{
 const b=new ChromiumDriver();try{await b.start();const group={group:'select',totalPairs:0,coveredPairs:0,scenarios:[{id:'s1',assignments:[{selector:'#kind',state:'selected',kind:'input',value:'first-available-option'},{selector:'#submit',kind:'action',state:'activate',value:'activate'}]}]};
 const r=await runCombinationCases(b,group,{acknowledgeDisposableEnvironment:true,reset:async browser=>{await documentContent(browser,`<select id="kind"><option value="">None</option><option value="paid">Paid</option></select><button id="submit">submit</button><span id="result"></span><script>document.querySelector('#submit').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#kind').value</script>`);},rules:[{when:{'#kind':'selected','#submit':'activate'},assertions:[{action:'expectText',selector:'#result',equals:'paid'}]}]});
 assert.equal(r.cases[0].status,'PASS',JSON.stringify(r));
 }finally{await b.stop()}
});

test('stable asynchronous assertion refuses stale PASS before erroneous delayed render',async()=>{
 const b=new ChromiumDriver();try{await b.start();await createCheckout(b);
   await b.evaluate(`document.querySelector('#total').textContent='20';window.__broken=true`);
   await b.click('#buy');
   const r=await executeStep(b,{action:'expectEventually',timeoutMs:650,stableForMs:160,assertion:{action:'expectNumber',selector:'#total',equals:20}});
   assert.equal(r.pass,false,JSON.stringify(r));assert.equal((await b.inspect('#total')).text,'12');
 }finally{await b.stop()}
});

test('24 real browser business-rule cases identify deliberate mutations without false FAIL on unmutated functions',async()=>{
 const b=new ChromiumDriver();try{await b.start();await createCheckout(b);
  let detected=0,correctPass=0,idx=0;
  for(const price of [4,8,11])for(const qty of [2,5])for(const rate of ['1','0.5'])for(const broken of [false,true]){
   idx++;await b.fill('#price',price);await b.fill('#qty',qty);assert.equal((await b.selectOption('#rate',rate)).pass,true);
   await b.evaluate(`window.__broken=${JSON.stringify(broken)}`);await b.click('#buy');
   const r=await executeStep(b,{action:'expectEventually',timeoutMs:650,stableForMs:110,assertion:{action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#price'},{selector:'#qty'},{selector:'#rate'}]}});
   if(broken){assert.equal(r.pass,false,JSON.stringify({idx,price,qty,rate,r}));detected++;}
   else {assert.equal(r.pass,true,JSON.stringify({idx,price,qty,rate,r}));correctPass++;}
  }
  assert.equal(detected,12);assert.equal(correctPass,12);
 }finally{await b.stop()}
});

test('independent Chromium sessions do not share app state',async()=>{
 const a=new ChromiumDriver(),b=new ChromiumDriver();try{await Promise.all([a.start(),b.start()]);await Promise.all([createCheckout(a),createCheckout(b)]);
  await a.fill('#price',42);assert.equal((await a.inspect('#price')).value,'42');assert.equal((await b.inspect('#price')).value,'10');
  assert.notEqual(a.tempDir,b.tempDir);
 }finally{await Promise.allSettled([a.stop(),b.stop()])}
});
