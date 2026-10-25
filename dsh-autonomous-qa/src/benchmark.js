/** Reproducible identical-budget A/B comparison, with explicit synthetic-fault caveats. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildMarkupIndex,planTagCombinations} from './markup.js';
import {planConstrainedCoveringGroup} from './algorithms.js';
import {fixtures} from '../bench/fixtures.js';

function allPairs(factors){
  const found=new Set();for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)for(const a of factors[i].levels)for(const b of factors[j].levels)found.add(`${i}:${a.id}|${j}:${b.id}`);return found;
}
const asState=scenario=>Object.fromEntries(scenario.assignments.map(a=>[a.selector,a.state]));
const matches=(actual,pattern)=>Object.entries(pattern).every(([k,v])=>actual[k]===v);
function assess(group,fixtures,baseline,algorithm){
  const factors=group.factorDefinitions,feasiblePairs=new Set();
  const domain=allPairs(factors);
  // The full feasible universe is known to algorithm; baseline is evaluated against exactly same feasible universe.
  // For each case, detect coverage of feasible pairs, independently of oracle correctness.
  for(const key of domain){
    const m=/^(\d+):([^|]+)\|(\d+):(.+)$/.exec(key),want={[factors[+m[1]].selector]:m[2],[factors[+m[3]].selector]:m[4]};
    // For this small independent benchmark, enumerate all combinations of other factors with early exit.
    function canComplete(i,state){
      if(i===factors.length)return !fixtures.constraints.some(c=>matches(state,c.when));
      const selector=factors[i].selector;
      if(selector in want)return canComplete(i+1,{...state,[selector]:want[selector]});
      for(const lev of factors[i].levels){
        const next={...state,[selector]:lev.id};
        if(fixtures.constraints.some(c=>Object.entries(c.when).every(([k,v])=>next[k]===v)))continue;
        if(canComplete(i+1,next))return true;
      }
      return false;
    }
    if(canComplete(0,{}))feasiblePairs.add(key);
  }
  function measure(g){
    let invalid=0;const covered=new Set(),faults=new Set();
    for(const scenario of g.scenarios){
      const states=asState(scenario);
      if(fixtures.constraints.some(c=>matches(states,c.when))){invalid++;continue;}
      for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++){
        const key=`${i}:${states[factors[i].selector]}|${j}:${states[factors[j].selector]}`;
        if(feasiblePairs.has(key))covered.add(key);
      }
      for(const f of fixtures.faults)if(matches(states,f.when))faults.add(f.id);
    }
    return {planned:g.scenarios.length,valid:g.scenarios.length-invalid,invalid,feasiblePairCoverage:feasiblePairs.size?covered.size/feasiblePairs.size:1,coveredPairs:covered.size,feasiblePairs:feasiblePairs.size,detectedFaults:[...faults].sort(),detectedCount:faults.size,faultUniverse:fixtures.faults.length};
  }
  return {baseline:measure(baseline),algorithm:measure(algorithm)};
}
function generateHeldOutPairFaults(group,fixture,seed,count=4){
  let state=(seed>>>0)||1;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  const factors=group.factorDefinitions,candidates=[];
  function feasible(pattern){
    function dfs(i,row){
      if(i===factors.length)return !fixture.constraints.some(c=>matches(row,c.when));
      const selector=factors[i].selector;
      for(const l of factors[i].levels){
        if(pattern[selector]!==undefined&&pattern[selector]!==l.id)continue;
        const next={...row,[selector]:l.id};
        if(fixture.constraints.some(c=>matches(next,c.when)))continue;
        if(dfs(i+1,next))return true;
      }
      return false;
    }
    return dfs(0,{});
  }
  for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)
    for(const a of factors[i].levels)for(const b of factors[j].levels){
      const pattern={[factors[i].selector]:a.id,[factors[j].selector]:b.id};
      if(feasible(pattern))candidates.push(pattern);
    }
  for(let i=candidates.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
  return candidates.slice(0,count).map((when,i)=>({id:`holdout-${i+1}`,when}));
}
export async function runComparison({budgetOverride=null,holdoutSeed=null}={}){
  const start=performance.now(),root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-algo-compare-')),results=[];
  try{
    for(const fixture of fixtures){
      const file=path.join(root,`${fixture.id}.html`);
      const html=`<form id="${fixture.id}">${fixture.controls.map(([id,type])=>type==='button'?`<button id="${id}" type="button">${id}</button>`:`<input id="${id}" type="${type}">`).join('\n')}</form>`;
      await fs.writeFile(file,html);
      const index=buildMarkupIndex(root);
      const maxCases=budgetOverride||fixture.budget;
      const old=performance.now();const baseline=planTagCombinations(index,{file:`${fixture.id}.html`,maxCases}).groups[0];const baselineMs=performance.now()-old;
      const group=baseline;
      const alg=planConstrainedCoveringGroup(group,{maxCases,constraints:fixture.constraints,seed:17});
      const evaluationFixture=holdoutSeed===null?fixture:{...fixture,faults:generateHeldOutPairFaults(group,fixture,((holdoutSeed+1)*9973+results.length*131)>>>0)};
      const measured=assess(group,evaluationFixture,baseline,alg);
      results.push({id:fixture.id,budget:maxCases,baseline:measured.baseline,algorithm:measured.algorithm,planningMs:{baseline:baselineMs,algorithm:alg.planningMs+baselineMs},constraintCount:fixture.constraints.length});
    }
    const total=(which,field)=>results.reduce((a,r)=>a+r[which][field],0);
    const faults=results.reduce((a,r)=>a+r.baseline.faultUniverse,0);
    const pairFraction=which=>results.reduce((n,r)=>n+r[which].coveredPairs,0)/results.reduce((n,r)=>n+r[which].feasiblePairs,0);
    return {name:'synthetic-combination-A-B',version:'0.4.0',design:'same seeded projects, independent faults, same maximum case budget; baseline=v0.3 greedy planner; algorithm=explicitly constrained weighted pairwise covering',
      fixtures:results.length,holdoutSeed,estimatedWallMs:performance.now()-start,summary:{totalFaults:faults,baseline:{planned:total('baseline','planned'),invalid:total('baseline','invalid'),detected:total('baseline','detectedCount'),faultDetectionRate:total('baseline','detectedCount')/faults,feasiblePairCoverage:pairFraction('baseline')},algorithm:{planned:total('algorithm','planned'),invalid:total('algorithm','invalid'),detected:total('algorithm','detectedCount'),faultDetectionRate:total('algorithm','detectedCount')/faults,feasiblePairCoverage:pairFraction('algorithm')}},cases:results,
      caveats:['Fault triggers are deterministic synthetic injections, not independently sampled production bugs. Held-out mode seeds independent pair-trigger labels after both plans are generated.','This A/B evaluates input-combination planning, not DSH installation, visual QA, runtime fault attribution or full UI correctness.','Fault detection is measured by whether an independent injected trigger was reached; actual browser execution is tested separately.','Planning runtimes include JS execution and may vary with hardware; benchmark Both planning times exclude common source indexing; the algorithm time includes baseline factor extraction.']};
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
