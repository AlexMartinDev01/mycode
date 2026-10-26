import fs from 'node:fs/promises';
import {runComparison} from '../src/benchmark.js';
const runs=[],count=20;
for(let seed=0;seed<count;seed++)runs.push(await runComparison({holdoutSeed:seed}));
const sum=(which,key)=>runs.reduce((x,r)=>x+r.summary[which][key],0);
const faults=runs.reduce((x,r)=>x+r.summary.totalFaults,0);
const result={name:'seeded-synthetic-pair-holdouts',seeds:count,seedRange:[0,count-1],totalInjectedPairFaults:faults,
  baseline:{detected:sum('baseline','detected'),rate:sum('baseline','detected')/faults,invalid:sum('baseline','invalid')},
  algorithm:{detected:sum('algorithm','detected'),rate:sum('algorithm','detected')/faults,invalid:sum('algorithm','invalid')},
  caveats:['Pair-trigger synthetic faults are generated independently of either plan; they are not real project bugs.','Each seed uses the same five fixtures, and seeds are not independent real applications.','The algorithm has explicit constraint information unavailable to the v0.3 baseline.']};
await fs.writeFile(new URL('./holdout-results-v0.4.0.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
