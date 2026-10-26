/** Reproducible, seeded property stress for constrained tag combinations. Synthetic, not real-project bug rate. */
import fs from 'node:fs';
import {planConstrainedCoveringGroup} from '../src/algorithms.js';
const started=performance.now(),iterations=1000;
let generated=0,feasiblePairs=0,coveredPairs=0,constraintViolations=0,coverageInconsistent=0,duplicateCases=0,emptyPlans=0;
for(let seed=1;seed<=iterations;seed++){
  const count=3+(seed%4),factors=Array.from({length:count},(_,i)=>({node:`node-${i}`,selector:`#f${i}`,kind:'input',file:'synthetic.tsx',line:i+1,risk:1+i%3,levels:Array.from({length:2+((seed+i)%2)},(_,j)=>({id:`v${j}`,value:j}))}));
  const totalPairs=factors.reduce((s,f,i)=>s+factors.slice(i+1).reduce((sum,g)=>sum+f.levels.length*g.levels.length,0),0);
  const group={group:'stress',totalPairs,factorDefinitions:factors};
  const forbidden=[{when:{'#f0':'v0','#f1':'v0'}}];
  const result=planConstrainedCoveringGroup(group,{seed,maxCases:20,constraints:forbidden});
  if(!result.scenarios.length)emptyPlans++;
  feasiblePairs+=result.totalPairs;coveredPairs+=result.coveredPairs;generated+=result.scenarios.length;
  if(result.totalPairs!==result.coveredPairs+result.uncoveredPairs)coverageInconsistent++;
  const seen=new Set();
  for(const scenario of result.scenarios){
    const s=Object.fromEntries(scenario.assignments.map(a=>[a.selector,a.state]));
    if(s['#f0']==='v0'&&s['#f1']==='v0')constraintViolations++;
    const key=scenario.assignments.map(a=>a.state).join('/');if(seen.has(key))duplicateCases++;seen.add(key);
  }
}
const result={kind:'synthetic-property-stress',iterations,generatedScenarios:generated,feasiblePairs,coveredPairs,pairwiseCoverage:coveredPairs/feasiblePairs,duplicateCases,constraintViolations,coverageInconsistent,emptyPlans,elapsedMs:Math.round(performance.now()-started),limitations:['No browser or natural software faults in this property stress.','Search bounds may leave feasible pairs uncovered; no claim of exhaustive coverage.']};
fs.writeFileSync(new URL('./stress-results-v0.5.0.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(constraintViolations||duplicateCases||coverageInconsistent||emptyPlans)process.exitCode=1;
