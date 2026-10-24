#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { scanProject } from './scanner.js';
import { runScenario } from './engine.js';
const args=process.argv.slice(2);
const opt=(key,otherwise)=>{const i=args.indexOf('--'+key);return i>=0?args[i+1]:otherwise;};
const command=args[0];
try {
  if(command==='scan'){
    const root=path.resolve(opt('project','.'));
    const report=scanProject(root);
    const file=opt('out');if(file)await fs.writeFile(file,JSON.stringify(report,null,2));
    console.log(JSON.stringify({summary:report.summary,diagnostics:report.diagnostics,skipped:report.skipped},null,2));
    process.exitCode=report.diagnostics.length?2:0;
  }else if(command==='run'){
    const spec=JSON.parse(await fs.readFile(path.resolve(opt('spec','qa.spec.json')),'utf8'));
    const report=await runScenario({...spec,projectRoot:path.resolve(opt('project',spec.projectRoot||'.')),outputDir:opt('out',spec.outputDir),chromium:opt('chromium',spec.chromium)});
    console.log(JSON.stringify({summary:report.summary,outputs:report.outputs,fatal:report.fatalError||null},null,2));
    process.exitCode=report.fatalError||report.summary.fail||report.summary.visualFail?1:0;
  }else{console.log('Usage: node src/cli.js scan --project PATH [--out FILE] | run --project PATH --spec qa.spec.json [--out DIR]');process.exitCode=1;}
}catch(e){console.error(e.stack);process.exitCode=1;}
