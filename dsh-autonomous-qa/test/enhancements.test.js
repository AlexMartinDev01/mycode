import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { buildSemanticIndex,traceCalls } from '../src/semantic.js';
import { ChromiumDriver } from '../src/browser.js';
import { executeStep } from '../src/engine.js';
import { correlateFindings } from '../src/diagnostics.js';
import { scanProject } from '../src/scanner.js';
const fixture=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../fixtures/buggy-app');
const setHtml=async(b,html)=>{
  const frame=(await b.cdp.command('Page.getFrameTree')).frameTree.frame.id;
  await b.cdp.command('Page.setDocumentContent',{frameId:frame,html});
};
test('cross-file call graph resolves imported function symbols and exact source lines',()=>{
  const idx=buildSemanticIndex(fixture);
  assert.equal(idx.summary.resolvedCalls,2);
  const trace=traceCalls(idx,{file:'src/app.js',symbol:'<module>'});
  assert.ok(trace.edges.some(e=>e.to==='src/state.js#renderTotal'&&e.line===5));
  assert.ok(trace.edges.some(e=>e.to==='src/pricing.js#calculateTotal'));
  assert.equal(trace.complete,false);
});
test('trace supports renamed imports and configured TypeScript path aliases',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-alias-'));
  try{
    await fs.mkdir(path.join(dir,'src'),{recursive:true});
    await fs.writeFile(path.join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@lib/*':['src/*']}}}));
    await fs.writeFile(path.join(dir,'src','start.ts'),"import { compute as doMath } from '@lib/math';\nexport function handle(){ return doMath(3); }\n");
    await fs.writeFile(path.join(dir,'src','math.ts'),"export function compute(n:number){return n+1}\n");
    const r=buildSemanticIndex(dir),t=traceCalls(r,{file:'src/start.ts',symbol:'handle'});
    assert.ok(t.edges.some(x=>x.to==='src/math.ts#compute'),JSON.stringify(r));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Vue script setup retains precise file line mapping for semantic calls',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-vue-'));
  try{
    await fs.writeFile(path.join(dir,'View.vue'),'<template><button @click="go">OK</button></template>\n<script setup lang="ts">\nfunction go() { return helper(); }\nfunction helper(){return true}\n</script>\n');
    const r=buildSemanticIndex(dir),link=r.links.find(x=>x.from==='View.vue#go');
    assert.equal(link.to,'View.vue#helper');assert.equal(link.line,3);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('independent derived business oracle catches faulty rendered amount',async()=>{
  const b=new ChromiumDriver();
  try{
    await b.start();await setHtml(b,'<div id="unit">100</div><input id="qty" value="3"/><div id="total">103</div>');
    const step={action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#unit',from:'text'},{selector:'#qty'}]};
    const bad=await executeStep(b,step);assert.equal(bad.pass,false);assert.equal(bad.expected,300);assert.equal(bad.actual,103);
    await b.evaluate("document.getElementById('total').textContent='300'");
    assert.equal((await executeStep(b,step)).pass,true);
    assert.equal((await executeStep(b,{...step,operation:'arbitraryScript'}).catch(e=>e.message)).includes('Unsupported independent oracle'),true);
  }finally{await b.stop();}
});
test('missing oracle inputs are UNKNOWN, not false pass',async()=>{
  const b=new ChromiumDriver();try{await b.start();await setHtml(b,'<div id="total">300</div>');
    const r=await executeStep(b,{action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#missing'}]});
    assert.equal(r.verdict,'UNKNOWN');assert.equal(r.pass,null);
  }finally{await b.stop();}
});
test('attribute and count assertions have explicit pass/fail outcomes',async()=>{
  const b=new ChromiumDriver();try{await b.start();await setHtml(b,'<button disabled id="b">Save</button><span class="item"></span><span class="item"></span>');
    assert.equal((await executeStep(b,{action:'expectAttribute',selector:'#b',attribute:'disabled',equals:''})).pass,true);
    assert.equal((await executeStep(b,{action:'expectCount',selector:'.item',equals:2})).pass,true);
    assert.equal((await executeStep(b,{action:'expectCount',selector:'.item',equals:3})).pass,false);
  }finally{await b.stop();}
});
test('network assertions read actual recorded HTTP method/status, cannot synthesize success',async()=>{
  const b={logs:{network:[{url:'http://localhost/api/orders',status:201,httpMethod:'POST',method:'RESPONSE'}]}};
  assert.equal((await executeStep(b,{action:'expectNetwork',urlIncludes:'/api/orders',status:201,httpMethod:'POST'})).pass,true);
  assert.equal((await executeStep(b,{action:'expectNetwork',urlIncludes:'/api/orders',status:200})).pass,false);
});
test('functional failures include cross-file source candidates, all marked unconfirmed',()=>{
  const semantic=buildSemanticIndex(fixture),scan=scanProject(fixture);
  const report={semantic,tests:[{index:0,status:'FAIL',step:{action:'expectDerived',selector:'#total'},result:{actual:103,expected:300}}],visual:{issues:[]}};
  const result=correlateFindings(scan,report).functional[0];
  assert.ok(result.candidates.some(x=>x.file==='src/pricing.js'&&x.function==='calculateTotal'),JSON.stringify(result));
  assert.equal(result.rootCauseStatus,'NOT_CONFIRMED');
});
test('visual CSS attribution returns original declaration line candidates for obstructing overlay',()=>{
  const scan=scanProject(fixture),report={tests:[],visual:{issues:[{type:'interactive-obstructed',selector:'#buy',detail:{hit:'#overlay'}}]}};
  const found=correlateFindings(scan,report).visual[0];
  assert.ok(found.candidates.some(x=>x.file==='src/style.css'&&x.selector==='#overlay'&&x.line===4));
});
test('independent layout contracts verify real geometry, overlap and CSS evidence',async()=>{
  const b=new ChromiumDriver();try{await b.start();
    await setHtml(b,'<style>#a{position:absolute;left:2px;top:10px;width:100px;height:40px;background:blue}#b{position:absolute;left:50px;top:20px;width:100px;height:40px;background:red}</style><button id="a">A</button><button id="b">B</button>');
    assert.equal((await executeStep(b,{action:'expectLayout',selector:'#a',minWidth:95,insideViewport:true})).pass,true);
    const overlap=await executeStep(b,{action:'expectLayout',selector:'#a',relativeTo:'#b',mustNotOverlap:true});
    assert.equal(overlap.pass,false);assert.ok(overlap.failures.includes('overlap'));assert.ok(overlap.cssEvidence.matched);
    const missing=await executeStep(b,{action:'expectLayout',selector:'#absent',insideViewport:true});
    assert.equal(missing.verdict,'UNKNOWN');
  }finally{await b.stop();}
});
test('successful full suite execution against real Chromium in-memory project fixture: detects logic and visual defects',async()=>{
  const {runScenario}=await import('../src/engine.js');
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-v02-integration-'));
  try{
    const report=await runScenario({projectRoot:fixture,outputDir:out,autoVisual:true,viewports:[{width:375,height:700}],
      prepareBrowser:async(browser)=>{
        const html='<style>body{margin:0}#buy{position:absolute;top:120px;left:10px;width:110px;height:44px}#overlay{position:absolute;top:110px;left:0;width:250px;height:90px;z-index:10;background:#666}#total{display:block}</style><div id="unit">100</div><input id="quantity" value="3"><button id="buy">Buy</button><span id="total">103</span><div id="overlay">Cover</div>';
        await setHtml(browser,html);
      },steps:[
        {action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#unit',from:'text'},{selector:'#quantity'}]},
        {action:'expectLayout',selector:'#buy',relativeTo:'#overlay',mustNotOverlap:true},
        {action:'visual',cssEvidence:true}
      ]
    });
    assert.equal(report.summary.fatal,false,report.fatalError);
    assert.equal(report.summary.fail,2,JSON.stringify(report.tests));
    assert.equal(report.summary.suspect,1);
    assert.ok(report.visual.issues.some(x=>x.type==='interactive-obstructed'));
    assert.ok(report.codeCandidates.functional[0].candidates.some(x=>x.file==='src/pricing.js'));
    assert.ok(report.semantic.summary.resolvedCalls>=2);
    assert.ok((await fs.readFile(path.join(out,'report.md'),'utf8')).includes('Source coverage'));
  }finally{await fs.rm(out,{recursive:true,force:true});}
});
test('step-level external navigation flag cannot override browser policy',async()=>{
  const b={options:{allowExternal:false},navigate:async(u,opts)=>opts};
  assert.equal((await executeStep(b,{action:'navigate',url:'https://example.com',allowExternal:true})).allowExternal,false);
  b.options.allowExternal=true;
  assert.equal((await executeStep(b,{action:'navigate',url:'https://example.com',allowExternal:true})).allowExternal,true);
});
test('cross-file argument mapping links caller expressions to callee parameters and return evidence',()=>{
  const idx=buildSemanticIndex(fixture);
  const p=idx.links.find(x=>x.to==='src/pricing.js#calculateTotal');
  assert.deepEqual(p.argumentMappings.map(m=>[m.parameter,m.argument]),[['price','price'],['quantity','quantity']]);
  const calc=idx.symbols.find(x=>x.key==='src/pricing.js#calculateTotal');
  assert.equal(calc.returns[0].expression,'price + quantity');
  assert.equal(calc.returns[0].line,2);
});
