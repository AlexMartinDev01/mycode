import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {scanProject,enumerateFiles} from '../src/scanner.js';
import {ChromiumDriver,validateLocalUrl} from '../src/browser.js';
import {executeStep,runScenario} from '../src/engine.js';
import {auditVisual,enrichVisualFindings} from '../src/visual.js';
import {comparePngFiles} from '../src/png.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=path.join(root,'fixtures/buggy-app');
const read=p=>fs.readFile(path.join(fixture,p),'utf8');

function fixtureSource(code){return code.replace(/^import\s+.*?;\s*$/gm,'').replace(/^export\s+/gm,'');}
async function loadFixture(browser,{blocked=false}={}){
  const style=await read('src/style.css');
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style}${blocked?'':'#overlay{display:none}'}</style></head><body>
    <div id="panel"><label>Quantity <input id="quantity" value="3"></label><button id="buy">Buy</button><p>Total: <span id="total">0</span></p></div><div id="overlay">Blocking bar</div></body></html>`;
  const frame=(await browser.cdp.command('Page.getFrameTree')).frameTree.frame.id;
  await browser.cdp.command('Page.setDocumentContent',{frameId:frame,html});
  const merged=['src/pricing.js','src/state.js','src/app.js'].map(read).map(async p=>fixtureSource(await p));
  await browser.evaluate((await Promise.all(merged)).join('\n'));
}

test('scans all fixture source files, resolves cross-file dependency and original lines',()=>{
  const result=scanProject(fixture);
  assert.equal(result.summary.parsed,7);
  assert.ok(result.edges.some(e=>e.from==='src/app.js'&&e.to==='src/state.js'&&e.line===1));
  assert.ok(result.edges.some(e=>e.from==='src/state.js'&&e.to==='src/pricing.js'));
  const fn=result.modules.find(m=>m.file==='src/pricing.js').functions.find(f=>f.name==='calculateTotal');
  assert.equal(fn.line,1);
  assert.ok(result.styleRules.some(s=>s.file==='src/style.css'&&s.selector==='#overlay'));
});
test('ignores symlinks, never traverses unrelated files',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-scan-'));
  try{await fs.writeFile(path.join(dir,'a.ts'),'export const x = 1');await fs.symlink('/etc/passwd',path.join(dir,'leak.ts'));const r=enumerateFiles(dir);assert.equal(r.files.length,1);assert.equal(r.skipped.length,1);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('external navigation blocked without explicit opt-in',()=>{
  assert.throws(()=>validateLocalUrl('https://example.com'),/Refusing external URL/);
  assert.match(validateLocalUrl('http://127.0.0.1:1234'),/127.0.0.1/);
  assert.match(validateLocalUrl('https://example.com',true),/example.com/);
  assert.throws(()=>validateLocalUrl('file:///etc/passwd'),/Only http/);
});

test('real Chromium CDP detects injected cross-file calculation defect',async()=>{
  const b=new ChromiumDriver();
  try{await b.start();await loadFixture(b);
    assert.equal((await executeStep(b,{action:'fill',selector:'#quantity',value:'3'})).value,'3');
    const clicked=await executeStep(b,{action:'click',selector:'#buy'});assert.equal(clicked.clicked,true);
    const assertion=await executeStep(b,{action:'expectNumber',selector:'#total',equals:300});
    assert.equal(assertion.pass,false);assert.equal(assertion.actual,103);
    assert.equal((await executeStep(b,{action:'expectText',selector:'#total',equals:'103'})).pass,true);
  }finally{await b.stop();}
});

test('visual analyzer detects overlay obstruction and locates matched CSS rule',async()=>{
  const b=new ChromiumDriver();
  try{await b.start();await loadFixture(b,{blocked:true});
    await assert.rejects(()=>b.click('#buy'),/obstructed/);
    const v=await auditVisual(b);const issue=v.issues.find(i=>i.type==='interactive-obstructed'&&i.selector==='#buy');
    assert.ok(issue,JSON.stringify(v.issues));
    await enrichVisualFindings(b,[issue]);
    assert.ok(issue.cssEvidence?.rules?.some(r=>r.selector==='#buy'));
    assert.equal((await b.cssFor('#overlay')).matched,true);
  }finally{await b.stop();}
});

test('browser screenshot pixel comparison detects visual changes and keeps unchanged baseline',async()=>{
  const b=new ChromiumDriver();const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-img-'));
  try {await b.start();await loadFixture(b);
    const a=path.join(tmp,'a.png'),same=path.join(tmp,'same.png'),changed=path.join(tmp,'changed.png');
    await b.screenshot(a);await b.screenshot(same);
    assert.equal((await comparePngFiles(a,same)).pass,true);
    await b.evaluate(`document.body.style.backgroundColor='rgb(0, 220, 0)'`);
    await b.screenshot(changed);const diff=await comparePngFiles(changed,a);
    assert.equal(diff.pass,false);assert.ok(diff.changedRatio>0.05);
  }finally{await b.stop();await fs.rm(tmp,{recursive:true,force:true});}
});

test('full workflow generates auditable JSON and Markdown without claiming 100% coverage',async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-report-'));
  try{
    // Environment-managed Chromium explicitly forbids all URL navigation. Use about:blank for the driver tests above.
    // Here verify fatal handling and honest reporting on policy-blocked navigations.
    const r=await runScenario({projectRoot:fixture,url:'http://127.0.0.1:8765/fixtures/buggy-app/index.html',outputDir:tmp,autoVisual:false});
    assert.equal(r.summary.fatal,true);
    const obj=JSON.parse(await fs.readFile(path.join(tmp,'report.json'),'utf8'));
    assert.ok(obj.fatalError);
    assert.match(await fs.readFile(path.join(tmp,'report.md'),'utf8'),/Fatal error/);
    assert.ok(obj.limitations.some(s=>s.includes('root-cause')));
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('source correlation supplies accurate candidates without inventing proven root cause',async()=>{
  const {correlateFindings}=await import('../src/diagnostics.js');
  const g=scanProject(fixture);
  const r=correlateFindings(g,{
    tests:[{index:0,status:'FAIL',step:{selector:'#total'},result:{actual:103}}],
    visual:{issues:[{type:'interactive-obstructed',selector:'#buy',detail:{hit:'#overlay'}}]}
  });
  assert.ok(r.functional[0].candidates.some(x=>x.file==='src/app.js'&&x.line===5));
  assert.ok(r.visual[0].candidates.some(x=>x.file==='src/style.css'&&x.selector==='#overlay'&&x.line===4));
  assert.equal(r.functional[0].rootCauseStatus,'NOT_CONFIRMED');
});

test('DSH plugin contract registers autonomous tools (mocked host)',async()=>{
  const {pathToFileURL}=await import('node:url');
  const source=await fs.readFile(path.join(root,'src/plugin.js'),'utf8');
  const mockPath=path.join(root,'src/.plugin-contract-test.mjs');
  const mock=source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';",'const defineTool = x=>x;');
  await fs.writeFile(mockPath,mock);
  try{
    const p=await import(pathToFileURL(mockPath)+'?'+Date.now());
    const tools=[],cleanups=[];
    p.apply({tools:{register:t=>tools.push(t)},effect:f=>cleanups.push(f())});
    assert.equal(tools.length,7);
    for(const name of ['frontend_qa_scan','frontend_qa_action','frontend_qa_visual_audit','frontend_qa_run_suite'])assert.ok(tools.some(t=>t.name===name));
    const result=JSON.parse(await tools.find(t=>t.name==='frontend_qa_scan').execute({projectRoot:fixture}));
    assert.equal(result.summary.imports,2);
    for(const c of cleanups)c();
  }finally{await fs.rm(mockPath,{force:true});}
});


test('autonomous explorer discovers controls but does not claim unverified correctness',async()=>{
  const {explorePage}=await import('../src/explorer.js');
  const b=new ChromiumDriver();
  try {await b.start();await loadFixture(b);const d=await explorePage(b,{executeSafeClicks:false});
    assert.ok(d.actions.some(x=>x.selector==='#buy'));
    assert.equal(d.executed,0);
    assert.equal(d.actions.find(x=>x.selector==='#buy').execution,'NOT_TESTED');
  }finally{await b.stop();}
});


test('responsive viewport probe flags horizontal overflow on narrow layout',async()=>{
  const b=new ChromiumDriver();try{await b.start();await loadFixture(b);
    await b.setViewport(375,800);const v=await auditVisual(b);
    assert.ok(v.issues.some(x=>x.type==='horizontal-overflow'),JSON.stringify(v.issues));
    assert.equal(v.viewport.width,375);
  }finally{await b.stop();}
});
