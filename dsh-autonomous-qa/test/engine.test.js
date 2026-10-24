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
  const html=`<!doctype html><html><head><style>${style}${blocked?'':'#overlay{display:none}'}</style></head><body>
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
