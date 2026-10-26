import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildMarkupIndex,planTagCombinations} from '../src/markup.js';
import {planConstrainedCoveringGroup,planAlgorithmicTagCombinations,planModelTransitions,rankFaultCandidates,minimizeFailingSequence} from '../src/algorithms.js';
import {runComparison} from '../src/benchmark.js';
import {runBrowserComparison} from '../src/browser-benchmark.js';
import {fixtures} from '../bench/fixtures.js';
async function testMarkup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qa-algo-unit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'screen.html'),'<form><input id="email" type="email"/><input id="quantity" type="number"/><input id="approved" type="checkbox"/><button id="run">Run</button></form>');
  return buildMarkupIndex(root);
}
const values=scenario=>Object.fromEntries(scenario.assignments.map(a=>[a.selector,a.state]));
test('Constrained pairwise planner preserves budget and avoids forbidden combinations',async t=>{
  const markup=await testMarkup(t),baseline=planTagCombinations(markup,{maxCases:8}).groups[0];
  const constraints=[{when:{'#approved':'unchecked','#run':'activate'}},{when:{'#email':'invalid','#quantity':'negative'}}];
  const algorithm=planConstrainedCoveringGroup(baseline,{maxCases:8,constraints,seed:3});
  assert.ok(algorithm.scenarios.length<=8);
  assert.equal(algorithm.scenarios.length,8);
  assert.ok(algorithm.scenarios.every(s=>!constraints.some(c=>Object.entries(c.when).every(([k,v])=>values(s)[k]===v))));
  assert.equal(algorithm.constraintsApplied,2);
  assert.ok(algorithm.totalPairs<=baseline.totalPairs);
  assert.ok(algorithm.scenarios.every(c=>c.oracleStatus==='UNKNOWN'&&c.verdict==='NOT_TESTED'));
  assert.deepEqual(algorithm.scenarios,planConstrainedCoveringGroup(baseline,{maxCases:8,constraints,seed:3}).scenarios);
});
test('Constraints cannot refer to unknown selectors or values',async t=>{
  const markup=await testMarkup(t),base=planTagCombinations(markup,{maxCases:8}).groups[0];
  assert.throws(()=>planConstrainedCoveringGroup(base,{constraints:[{when:{'#ghost':'empty'}}]}),/Unknown constraint selector/);
  assert.throws(()=>planConstrainedCoveringGroup(base,{constraints:[{when:{'#email':'never'}}]}),/Unknown constraint state/);
  assert.throws(()=>planConstrainedCoveringGroup(base,{constraints:[{}]}),/Invalid forbidden/);
});
test('Algorithm exposure matches baseline markup index and does not mutate original plan',async t=>{
  const markup=await testMarkup(t);const before=planTagCombinations(markup,{maxCases:10});
  const algo=planAlgorithmicTagCombinations(markup,{maxCases:10});
  assert.equal(before.summary.groups,algo.summary.groups);
  assert.ok(algo.groups[0].coveredPairs<=algo.groups[0].totalPairs);
  assert.equal(before.groups[0].scenarios[0].reason,'baseline');
});
test('Model BFS gives concrete state paths and reports uncovered transitions when bounded',()=>{
  const m={initial:'idle',transitions:[{from:'idle',to:'loading',action:'click'},{from:'loading',to:'success',action:'resolve'},{from:'loading',to:'error',action:'reject'}]};
  const complete=planModelTransitions(m,{maxDepth:4});
  assert.equal(complete.coveredTransitions,3);
  assert.deepEqual(complete.paths.find(p=>p.finalState==='success').steps.map(x=>x.action),['click','resolve']);
  assert.equal(planModelTransitions(m,{maxDepth:1}).coveredTransitions,1);
});
test('Ochiai ranks failing-only lines above shared lines without pretending causal proof',()=>{
  const result=rankFaultCandidates([{failed:true,coveredLines:['bad.js:7','shared.js:2']},{failed:true,coveredLines:['bad.js:7','shared.js:2']},{failed:false,coveredLines:['shared.js:2','other.js:3']}]);
  assert.equal(result[0].location,'bad.js:7');assert.equal(result[0].score,1);
  assert.ok(result.every(x=>x.rootCauseStatus==='NOT_CONFIRMED'));
});
test('Delta debugging removes irrelevant steps under a reproducible independent oracle',async()=>{
  const original=['open','noop1','type','noop2','submit','noop3'];
  const result=await minimizeFailingSequence(original,async steps=>steps.includes('type')&&steps.includes('submit'));
  assert.deepEqual(result.sequence,['type','submit']);assert.equal(result.status,'MINIMIZED');
  const unknown=await minimizeFailingSequence(original,async()=>false);
  assert.equal(unknown.status,'NOT_REPRODUCIBLE');
});
test('Same-budget offline A/B outputs reproducible measured differences, without promising universal improvement',async()=>{
  const a=await runComparison(),b=await runComparison();
  assert.deepEqual(a.summary,b.summary);
  assert.equal(a.fixtures,fixtures.length);
  assert.equal(a.summary.totalFaults,20);
  assert.ok(a.cases.every(r=>r.baseline.planned<=r.budget&&r.algorithm.planned<=r.budget));
  assert.ok(a.cases.some(r=>r.algorithm.feasiblePairCoverage>r.baseline.feasiblePairCoverage));
});
test('Real Chromium executes same-budget A/B with independently injected faults and no oracle disagreements',async()=>{
  const r=await runBrowserComparison({fixtureId:'signup',budget:12});
  assert.equal(r.baseline.budget,r.algorithm.budget);
  assert.equal(r.baseline.oracleDisagreements,0,JSON.stringify(r));
  assert.equal(r.algorithm.oracleDisagreements,0,JSON.stringify(r));
  assert.equal(r.baseline.suspect,0);assert.equal(r.algorithm.suspect,0);
  assert.equal(r.algorithm.observedFaultCount,4);
});
