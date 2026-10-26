import fs from 'node:fs';
import path from 'node:path';
/** Evidence-bearing source candidates. A path to a value is NOT automatically its causal root. */
export function correlateFindings(projectScan, report) {
  if (!projectScan) return {functional:[],visual:[]};
  const semantic=report.semantic||null;
  const sourceCache=new Map();
  const read=file=>{
    if(sourceCache.has(file))return sourceCache.get(file);
    let lines=[];
    try{
      const abs=path.resolve(projectScan.projectRoot,file);
      if(abs.startsWith(projectScan.projectRoot+path.sep))lines=fs.readFileSync(abs,'utf8').split('\n');
    }catch{}
    sourceCache.set(file,lines);return lines;
  };
  const unique=items=>{
    const found=new Set();return items.filter(x=>{
      const key=[x.file,x.line,x.relation||x.selector||''].join(':');
      if(found.has(key))return false;found.add(key);return true;
    });
  };
  function functionalCandidates(selector){
    if(!selector)return [];
    const out=[];
    for(const m of projectScan.modules){
      if(!/^(js|jsx|ts|tsx|vue)$/.test(m.kind))continue;
      for(const [i,line] of read(m.file).entries())if(line.includes(selector)){
        out.push({file:m.file,line:i+1,snippet:line.trim().slice(0,160),relation:'selector-reference',confidence:'C'});
      }
    }
    for(const bind of semantic?.domBindings||[])if(bind.selector===selector){
      // Module-level handlers and named component functions may call imported helpers.
      const starts=[`${bind.file}#<module>`,...(semantic?.symbols||[]).filter(s=>s.file===bind.file&&s.line<=bind.line&&s.endLine>=bind.line).map(s=>s.key)];
      const pending=starts.map(key=>({key,depth:0})),visited=new Set();
      while(pending.length){
        const {key,depth}=pending.shift();if(visited.has(key)||depth>5)continue;visited.add(key);
        for(const edge of semantic.links.filter(e=>e.from===key)){
          const target=semantic.symbols.find(s=>s.key===edge.to);
          if(target)out.push({file:target.file,line:target.line,function:target.name,relation:'reachable-direct-call',via:{file:edge.file,line:edge.line},confidence:'C'});
          pending.push({key:edge.to,depth:depth+1});
        }
      }
    }
    // Fall back to file dependencies where calls are indirect/unresolved.
    for(const ref of out.filter(x=>x.relation==='selector-reference')){
      for(const edge of projectScan.edges.filter(e=>e.from===ref.file&&e.kind==='import').slice(0,15)){
        const target=projectScan.modules.find(m=>m.file===edge.to);
        for(const fn of (target?.functions||[]).slice(0,8))out.push({file:target.file,line:fn.line,function:fn.name,relation:'import-linked (unconfirmed)',confidence:'C'});
      }
    }
    return unique(out).slice(0,60);
  }
  const functional=(report.tests||[]).filter(t=>t.status==='FAIL').map(t=>({
    testIndex:t.index,selector:t.step?.selector||null,reason:t.error||t.result?.actual,
    candidates:functionalCandidates(t.step?.selector),rootCauseStatus:'NOT_CONFIRMED',
    note:'Direct invocation and DOM reference paths only. A candidate line is not proof of an incorrect implementation.'
  }));
  const allIssues=[...(report.visual?.issues||[]),...(report.visualByViewport||[]).flatMap(v=>(v.audit?.issues||[]).map(x=>({...x,viewport:v.width+'x'+v.height})))];
  const visual=allIssues.map(issue=>{
    const selectors=new Set([issue.selector,issue.detail?.hit].filter(Boolean));
    const matching=projectScan.styleRules.filter(rule=>{
      if(!rule.selector)return false;
      const patterns=rule.selector.split(',').map(s=>s.trim());
      return [...selectors].some(sel=>patterns.some(p=>p===sel||sel.endsWith(' '+p)||sel.endsWith('>'+p)));
    });
    const evidence=issue.cssEvidence?.rules||[];
    const candidates=matching.map(rule=>{
      const provenMatch=evidence.some(e=>e.selector===rule.selector||rule.selector.includes(e.selector));
      const lines=rule.declarations?.filter(d=>evidence.some(e=>e.declarations?.some(ed=>ed.name===d.property&&ed.value===d.value))).map(d=>d.line)||[];
      return {file:rule.file,line:lines[0]||rule.line,selector:rule.selector,relation:provenMatch?'matched-runtime-style-rule':'static-selector-match',confidence:'C'};
    });
    return {issue:issue.type,selector:issue.selector,viewport:issue.viewport||null,candidates:unique(candidates).slice(0,40),rootCauseStatus:'NOT_CONFIRMED'};
  });
  return {functional,visual};
}
