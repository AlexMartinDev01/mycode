import fs from 'node:fs';
import path from 'node:path';
/** Evidence-bearing candidate source locations. Never promotes a line to confirmed root cause. */
export function correlateFindings(projectScan,report) {
  if(!projectScan)return {functional:[],visual:[]};
  const moduleMap=new Map(projectScan.modules.map(m=>[m.file,m]));
  const ancestors=new Map();
  const visit=(file,depth=0,seen=new Set())=>{
    if(depth>4||seen.has(file))return [];
    seen.add(file);
    const imports=projectScan.edges.filter(e=>e.from===file&&e.kind==='import');
    return [...imports.flatMap(x=>[{file:x.to,relation:'imported from '+file,line:x.line},...visit(x.to,depth+1,seen)])];
  };
  const searchMatches=(selector)=>{
    const refs=[];
    for(const m of projectScan.modules){if(!/^(js|jsx|ts|tsx|vue)$/.test(m.kind))continue;
      const content=fs.readFileSync(path.join(projectScan.projectRoot,m.file),'utf8');
      for(const [idx,line] of content.split('\n').entries()) if(line.includes(selector))refs.push({file:m.file,line:idx+1,snippet:line.trim().slice(0,150),confidence:'C'});
    }
    return refs.slice(0,25);
  };
  const functional=(report.tests||[]).filter(t=>t.status==='FAIL').map(t=>{
    const selector=t.step?.selector;
    const refs=selector?searchMatches(selector):[];
    const linked=refs.flatMap(x=>visit(x.file).slice(0,15));
    const funcs=linked.flatMap(x=>(moduleMap.get(x.file)?.functions||[]).slice(0,10).map(f=>({file:x.file,line:f.line,function:f.name,confidence:'C',relation:x.relation})));
    return {testIndex:t.index,selector:selector||null,reason:t.error||t.result?.actual,candidates:[...refs,...funcs].slice(0,35),rootCauseStatus:'NOT_CONFIRMED',note:'Candidates are code locations in observed display path, not proven causal root lines.'};
  });
  const visual=(report.visual?.issues||[]).map(issue=>{
    const selectors=new Set([issue.selector,issue.detail?.hit].filter(Boolean));
    const css=projectScan.styleRules.filter(r=>[...selectors].some(s=>s===r.selector||s?.split(/\s*[> ]\s*/).at(-1)===r.selector));
    return {issue:issue.type,selector:issue.selector,candidates:css.slice(0,15).map(r=>({file:r.file,line:r.line,selector:r.selector,confidence:'C'})),rootCauseStatus:'NOT_CONFIRMED'};
  });
  return {functional,visual};
}
