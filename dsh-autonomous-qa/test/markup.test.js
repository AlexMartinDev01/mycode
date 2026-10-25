import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildMarkupIndex,planTagCombinations} from '../src/markup.js';
import {runCombinationCases} from '../src/combination-runtime.js';
import {ChromiumDriver} from '../src/browser.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-combo-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'src'));
  await fs.writeFile(path.join(root,'src','logic.ts'),"export function submit(){ return true; }\n");
  await fs.writeFile(path.join(root,'src','Panel.vue'),`<template>\n  <form id="login-form" @submit.prevent="submit">\n    <label for="email">Email</label>\n    <input id="email" type="email" v-model="email" required />\n    <input id="password" type="text" :disabled="busy" v-model="password" />\n    <button id="go" @click="submit" v-if="ready && !busy">Go</button>\n    <p v-show="error">Bad input</p>\n  </form>\n</template>\n<script setup lang="ts">\nimport { submit } from './logic';\nconst email = '';\nconst password = '';\nconst busy = false;\nconst ready = true;\nconst error = false;\n</script>\n`);
  return root;
}
test('Vue templates map nested tags, directives, bindings, events and original code lines',async t=>{
  const root=await fixture(t),index=buildMarkupIndex(root);
  const form=index.nodes.find(n=>n.tag==='form'),btn=index.nodes.find(n=>n.tag==='button'),email=index.nodes.find(n=>n.selector==='#email');
  assert.equal(index.summary.files,1);
  assert.equal(email.line,4);
  assert.equal(btn.line,6);
  assert.equal(email.parent,form.key);
  assert.ok(index.edges.some(e=>e.from===form.key&&e.to===email.key&&e.kind==='contains'));
  assert.ok(index.edges.some(e=>e.from===btn.key&&e.to==='src/logic.ts#submit'&&e.kind==='event-handler'));
  assert.ok(email.bindings.some(b=>b.name==='v-model'&&b.refs.includes('email')));
  assert.ok(btn.conditions.some(c=>c.includes('ready && !busy')));
});
test('JSX AST tracks conditional elements, explicit props and cross-file component import',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'src','Widget.tsx'),"export default function Widget(){return <button id=\"widget\">OK</button>}\n");
  await fs.writeFile(path.join(root,'src','Page.tsx'),`import Widget from './Widget';\nexport function Page({open,onSave}:{open:boolean,onSave:()=>void}){return <main>{open && <section><Widget data-testid="widget-child"/><button id="save" onClick={onSave}>Save</button></section>}</main>;}\n`);
  const index=buildMarkupIndex(root),btn=index.nodes.find(n=>n.selector==='#save'),comp=index.nodes.find(n=>n.tag==='Widget');
  assert.equal(btn.line,2);
  assert.ok(btn.conditions.includes('open'));
  assert.ok(btn.events.some(e=>e.event==='Click'&&e.refs.includes('onSave')));
  assert.ok(index.edges.some(e=>e.from===comp.key&&e.to==='src/Widget.tsx'&&e.kind==='component-import'));
});
test('Template tokenizer handles greater-than in attributes and excludes script/style bodies',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'page.html'),`<div id="content" data-note="a > b"><button id="ok" onclick="go()">OK</button><script>const fake = '<button id="bad">';</script></div>`);
  const index=buildMarkupIndex(root),html=index.nodes.filter(n=>n.file==='page.html');
  assert.deepEqual(html.map(n=>n.tag),['div','button','script']);
  assert.equal(html[0].attributes.find(a=>a.name==='data-note').value,'a > b');
  assert.ok(!html.some(n=>n.selector==='#bad'));
});
test('Planner covers pairwise tag input levels under bounded case budget without fabricating expected values',async t=>{
  const root=await fixture(t),index=buildMarkupIndex(root);
  const plan=planTagCombinations(index,{maxCases:32});const group=plan.groups[0];
  assert.equal(group.fields,2);
  assert.equal(group.actions,1);
  assert.ok(group.totalPairs>9);
  assert.equal(group.coveredPairs,group.totalPairs);
  assert.ok(group.scenarios.every(c=>c.verdict==='NOT_TESTED'&&c.oracleStatus==='UNKNOWN'));
  assert.ok(group.scenarios.every(c=>c.assignments.every(a=>a.source.line>0)));
});
test('Combination tester refuses unauthorized or remote execution, and handles missing oracle explicitly',async t=>{
  const root=await fixture(t),group=planTagCombinations(buildMarkupIndex(root)).groups[0];
  await assert.rejects(()=>runCombinationCases({},group,{pageUrl:'http://localhost:1000'}),/authorization/);
  await assert.rejects(()=>runCombinationCases({},group,{pageUrl:'https://example.com',acknowledgeDisposableEnvironment:true}),/localhost/);
  const result=await runCombinationCases({},group,{reset:async()=>{},acknowledgeDisposableEnvironment:true,rules:[]});
  assert.equal(result.summary.executed,0);
  assert.ok(result.cases.every(x=>x.status==='UNKNOWN'));
});
test('Real Chromium executes bounded combinations and detects wrong cross-tag calculation from independent oracle',async t=>{
  const root=await fixture(t),dir=path.join(root,'src');
  await fs.writeFile(path.join(dir,'Panel.vue'),`<template><form><input id="unit" type="number"/><input id="quantity" type="number"/><output id="total"></output></form></template>`);
  const plan=planTagCombinations(buildMarkupIndex(root),{maxCases:18});const group=plan.groups[0];
  const browser=new ChromiumDriver();
  async function reset(b){
    const id=(await b.cdp.command('Page.getFrameTree')).frameTree.frame.id;
    await b.cdp.command('Page.setDocumentContent',{frameId:id,html:`<form><input id="unit" type="number" oninput="update()"><input id="quantity" type="number" oninput="update()"><output id="total">0</output></form><script>function update(){const a=+document.querySelector('#unit').value||0,b=+document.querySelector('#quantity').value||0;document.querySelector('#total').textContent=String(a+b)}</script>`});
  }
  try{
    await browser.start();
    const cases=await runCombinationCases(browser,group,{reset,acknowledgeDisposableEnvironment:true,maxCases:18,rules:[{when:{},assertions:[{action:'expectDerived',selector:'#total',operation:'multiply',inputs:[{selector:'#unit'},{selector:'#quantity'}]}]}]});
    assert.ok(cases.summary.failed>=1,JSON.stringify(cases.summary));
    assert.ok(cases.summary.unknown>=1);
    assert.equal(cases.summary.suspect,0,JSON.stringify(cases.cases));
  }finally{await browser.stop();}
});
test('Action-only components generate tag action-state combinations rather than being skipped',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'solo.html'),'<button id="open" onclick="toggle()">Open</button><div id="result"></div>');
  const plan=planTagCombinations(buildMarkupIndex(root),{file:'solo.html'});
  assert.equal(plan.summary.groups,1);
  assert.equal(plan.groups[0].actions,1);
  assert.ok(plan.groups[0].scenarios.some(c=>c.assignments.some(a=>a.state==='activate')));
});
test('Nested Vue template blocks do not drop later sibling markup',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'src','Nested.vue'),'<template><div><template v-if="ready"><button id="inner">A</button></template><button id="later">B</button></div></template><script setup>const ready = true</script>');
  const idx=buildMarkupIndex(root);
  assert.ok(idx.nodes.some(n=>n.selector==='#inner'));
  assert.ok(idx.nodes.some(n=>n.selector==='#later'));
});
test('Combination contract disallows navigation and other action injection as assertions',async t=>{
  const root=await fixture(t),group=planTagCombinations(buildMarkupIndex(root)).groups[0];
  await assert.rejects(()=>runCombinationCases({},group,{reset:async()=>{},acknowledgeDisposableEnvironment:true,rules:[{when:{},assertions:[{action:'navigate',url:'https://example.com'}]}]}),/read-only/);
});
