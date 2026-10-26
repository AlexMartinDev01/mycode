/** Optional, explicitly bounded algorithms. No business oracle is inferred from implementation. */
import {planTagCombinations} from './markup.js';
const MAX_FACTORS=12, MAX_CASES=64, MAX_SEARCH=25000;
const boundedInt=(v,d,max)=>Number.isInteger(v)?Math.max(1,Math.min(max,v)):d;
const keyPair=(i,a,j,b)=>`${i}:${a}|${j}:${b}`;
const stable=(a,b)=>a===b;

/** Constraints are forbidden partial assignments, for example {when:{'#email':'empty','#submit':'activate'}}. */
function normalizeConstraints(factors,constraints=[]){
  if(!Array.isArray(constraints)||constraints.length>100)throw new Error('constraints must be an array of at most 100 forbidden assignments');
  const selectors=new Map(factors.map((f,i)=>[f.selector,i]));
  return constraints.map((rule,r)=>{
    if(!rule||typeof rule.when!=='object'||rule.when===null||Array.isArray(rule.when)||!Object.keys(rule.when).length||rule.forbid===false)throw new Error(`Invalid forbidden constraint ${r}`);
    const required=[];
    for(const [selector,state] of Object.entries(rule.when)){
      const index=selectors.get(selector);
      if(index===undefined||typeof selector!=='string')throw new Error(`Unknown constraint selector: ${selector}`);
      const level=factors[index].levels.findIndex(l=>l.id===state);
      if(level<0)throw new Error(`Unknown constraint state: ${selector}=${state}`);
      required.push([index,level]);
    }
    return required;
  });
}
function valid(partial,constraints){
  return constraints.every(c=>!c.every(([i,v])=>partial[i]===v));
}
function tryComplete(partial,domains,constraints,prefer=[],limit=MAX_SEARCH){
  const a=[...partial];let visits=0;
  function dfs(i){
    if(++visits>limit)return null;
    if(i===a.length)return [...a];
    if(a[i]!==-1)return valid(a,constraints)?dfs(i+1):null;
    const n=domains[i];const seed=prefer[i]??0;
    for(let p=0;p<n;p++){
      a[i]=(p+seed)%n;
      if(valid(a,constraints)){
        const result=dfs(i+1);if(result)return result;
      }
    }
    a[i]=-1;return null;
  }
  return dfs(0);
}
function coveredPairs(row){const keys=[];for(let i=0;i<row.length;i++)for(let j=i+1;j<row.length;j++)keys.push(keyPair(i,row[i],j,row[j]));return keys;}
function pairUniverse(factors,constraints){
  const domains=factors.map(f=>f.levels.length),universe=new Map();
  for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)for(let a=0;a<domains[i];a++)for(let b=0;b<domains[j];b++){
    const key=keyPair(i,a,j,b),assignment=Array(factors.length).fill(-1);assignment[i]=a;assignment[j]=b;
    if(tryComplete(assignment,domains,constraints)!==null){
      // Static risk is estimated from labels, bindings and state mentions, never benchmark fault labels.
      const risk=(factors[i].risk||1)+(factors[j].risk||1);
      universe.set(key,risk);
    }
  }
  return universe;
}
function mapping(factors,row,group,index,reason){return {id:`${group}#algorithm-${index+1}`,group,reason,
  assignments:factors.map((f,i)=>({node:f.node,selector:f.selector,kind:f.kind,source:{file:f.file,line:f.line},state:f.levels[row[i]].id,value:f.levels[row[i]].value})),
  verdict:'NOT_TESTED',expected:null,oracleStatus:'UNKNOWN',executable:false};}
/** Risk-prioritized constrained 2-way covering-array planner, using greedy weighted set-cover.
 * Not claimed to be an IPOG implementation. Search caps are explicit. */
export function planConstrainedCoveringGroup(group,{maxCases=32,constraints=[],seed=11,candidateLimit=24}={}){
  if(!group||!Array.isArray(group.factorDefinitions))throw new Error('Group must come from planTagCombinations with factorDefinitions');
  const factors=group.factorDefinitions.slice(0,MAX_FACTORS);
  if(factors.some(f=>!f.selector))throw new Error('Deterministic combination planning requires CSS selectors for every factor');
  const cap=boundedInt(maxCases,32,MAX_CASES),rules=normalizeConstraints(factors,constraints);
  const universe=pairUniverse(factors,rules),remaining=new Map(universe),rows=[],seen=new Set();
  const domains=factors.map(f=>f.levels.length);
  const start=process.hrtime.bigint();
  function add(row,reason){if(!row||!valid(row,rules))return false;
    const unique=row.join(',');if(seen.has(unique))return false;
    rows.push({row,reason});seen.add(unique);for(const p of coveredPairs(row))remaining.delete(p);return true;
  }
  const baseline=domains.map(n=>Math.min(1,n-1));
  add(tryComplete(baseline,domains,rules), 'seed');
  if(factors.length===1){
    for(let a=0;a<domains[0]&&rows.length<cap;a++)add([a],'single-factor');
  }
  let round=0;
  while(remaining.size&&rows.length<cap&&round++<cap*5){
    let best=null,bestScore=-1;
    // For each uncovered pair, propose several deterministic feasible completions.
    const keys=[...remaining.keys()],take=Math.min(keys.length,180);
    for(let h=0;h<take;h++){
      const key=keys[(h+round*7)%keys.length];const m=/^(\d+):(\d+)\|(\d+):(\d+)$/.exec(key);
      const base=Array(factors.length).fill(-1);base[+m[1]]=+m[2];base[+m[3]]=+m[4];
      for(let attempt=0;attempt<Math.min(candidateLimit,8);attempt++){
        const prefer=domains.map((n,i)=>(seed+round*13+h*5+attempt*(i+1)*3)%n);
        const row=tryComplete(base,domains,rules,prefer,Math.min(MAX_SEARCH,2000));
        if(!row||seen.has(row.join(',')))continue;
        const score=coveredPairs(row).reduce((s,p)=>s+(remaining.get(p)||0),0);
        if(score>bestScore){best=row;bestScore=score;}
      }
    }
    if(!best||bestScore<=0)break;
    add(best,'weighted-cover');
  }
  const covered=universe.size-remaining.size;
  return {...group,algorithm:'constrained-weighted-covering-array',constraintsApplied:rules.length,
    analyzedFactors:factors.length,totalPairs:universe.size,coveredPairs:covered,uncoveredPairs:remaining.size,
    infeasiblePairs:group.totalPairs-universe.size,
    scenarios:rows.slice(0,cap).map(({row,reason},i)=>mapping(factors,row,group.group,i,reason)),
    planningMs:Number(process.hrtime.bigint()-start)/1e6,
    status:'PLAN_ONLY',limitations:[...(group.limitations||[]),'Greedy approximate set-cover, not proof of globally minimal covering array.','Only explicit forbidden-state constraints are enforced; business correctness needs independent oracles.']};
}
/** Apply the algorithm to the same markup extraction as the pre-existing v0.3 baseline. */
export function planAlgorithmicTagCombinations(markup,{file,maxCases=32,constraintsByGroup={},seed=11}={}){
  const old=planTagCombinations(markup,{file,maxCases});
  const groups=old.groups.map(g=>planConstrainedCoveringGroup(g,{maxCases,constraints:constraintsByGroup[g.group]||[],seed}));
  return {algorithm:'constrained-weighted-covering-array',summary:{groups:groups.length,scenarios:groups.reduce((n,g)=>n+g.scenarios.length,0),coveredPairs:groups.reduce((n,g)=>n+g.coveredPairs,0),feasiblePairs:groups.reduce((n,g)=>n+g.totalPairs,0),uncoveredPairs:groups.reduce((n,g)=>n+g.uncoveredPairs,0)},groups};
}
/** Bounded state-model BFS: each transition gets one shortest sequence (not all possible UI sequences). */
export function planModelTransitions({initial,transitions=[]},{maxDepth=8,maxSequences=64}={}){
  if(typeof initial!=='string'||!initial||!Array.isArray(transitions)||transitions.length>500)throw new Error('Invalid state model');
  const queue=[{state:initial,steps:[]}],visited=new Map([[initial,0]]),paths=[],edgesSeen=new Set();
  const depthLimit=boundedInt(maxDepth,8,32),caseLimit=boundedInt(maxSequences,64,256);
  while(queue.length&&paths.length<caseLimit){
    const current=queue.shift();if(current.steps.length>=depthLimit)continue;
    for(const [i,t] of transitions.entries()){
      if(t.from!==current.state||!t.to||!t.action)continue;
      const steps=[...current.steps,{action:t.action,from:t.from,to:t.to,transitionId:t.id||i}];
      if(!edgesSeen.has(i)){paths.push({id:`transition-${i}`,steps,finalState:t.to});edgesSeen.add(i);}
      if(!visited.has(t.to)||visited.get(t.to)>steps.length){visited.set(t.to,steps.length);queue.push({state:t.to,steps});}
      if(paths.length>=caseLimit)break;
    }
  }
  return {paths,transitionCoverage:transitions.length?edgesSeen.size/transitions.length:1,coveredTransitions:edgesSeen.size,totalTransitions:transitions.length,limitations:['State model must be provided or independently validated; no implicit correctness inferred from source.','Simple BFS does not explore repeated transitions or temporal races.']};
}
/** Ochiai suspiciousness: ranking only; NEVER root-cause proof. */
export function rankFaultCandidates(executions){
  if(!Array.isArray(executions))throw new Error('executions must be array');
  const failures=executions.filter(x=>x.failed===true).length,counts=new Map();
  for(const execution of executions){
    for(const location of new Set(execution.coveredLines||[])){
      if(typeof location!=='string')continue;
      const c=counts.get(location)||{failed:0,passed:0};c[execution.failed?'failed':'passed']++;counts.set(location,c);
    }
  }
  return [...counts].map(([location,c])=>({location,...c,score:failures?c.failed/Math.sqrt(failures*(c.failed+c.passed)):0,rootCauseStatus:'NOT_CONFIRMED'})).sort((a,b)=>b.score-a.score||a.location.localeCompare(b.location));
}
/** ddmin: bounded minimization of a reproducible failing input sequence. */
export async function minimizeFailingSequence(sequence,reproduces,{maxTrials=80}={}){
  if(!Array.isArray(sequence)||typeof reproduces!=='function')throw new Error('Invalid minimization arguments');
  let current=[...sequence],trials=0,n=2;
  if(!await reproduces(current))return {status:'NOT_REPRODUCIBLE',sequence:current,trials:1};
  trials++;
  while(current.length>=2&&trials<maxTrials){
    const size=Math.ceil(current.length/n);let reduced=false;
    for(let start=0;start<current.length&&trials<maxTrials;start+=size){
      const candidate=[...current.slice(0,start),...current.slice(start+size)];
      const yes=await reproduces(candidate);trials++;
      if(yes){current=candidate;n=Math.max(n-1,2);reduced=true;break;}
    }
    if(!reduced){if(n>=current.length)break;n=Math.min(current.length,n*2);}
  }
  return {status:trials>=maxTrials?'BUDGET_EXHAUSTED':'MINIMIZED',sequence:current,trials};
}
