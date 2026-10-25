import fs from 'node:fs/promises';
import path from 'node:path';
import {runComparison} from '../src/benchmark.js';
const r=await runComparison({budgetOverride:process.argv.includes('--budget')?Number(process.argv[process.argv.indexOf('--budget')+1]):null});
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:null;
if(output){await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(r,null,2)+'\n');}
console.log(JSON.stringify(r.summary,null,2));
for(const x of r.cases)console.log(`${x.id.padEnd(12)} budget=${x.budget} baseline ${x.baseline.detectedCount}/${x.baseline.faultUniverse} faults coverage=${(100*x.baseline.feasiblePairCoverage).toFixed(1)}% invalid=${x.baseline.invalid} | algorithm ${x.algorithm.detectedCount}/${x.algorithm.faultUniverse} coverage=${(100*x.algorithm.feasiblePairCoverage).toFixed(1)}% invalid=${x.algorithm.invalid}`);
