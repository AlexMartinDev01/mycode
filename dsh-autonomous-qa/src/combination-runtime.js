/** Execute bounded, independently specified tag-combination cases on an authorized disposable browser. */
import {executeStep} from './engine.js';

const MAX_CASES=40;
const ALLOWED_ASSERTIONS=new Set(['expectText','expectValue','expectVisible','expectUrl','expectStyle','expectNumber','expectDerived','expectAttribute','expectCount','expectNetwork','expectLayout']);
const EQ=(a,b)=>a===b;
function selectRules(assignments,rules){
  const states=Object.fromEntries(assignments.filter(a=>a.selector).map(a=>[a.selector,a.state]));
  const matched=(rules||[]).filter(rule=>rule&&typeof rule.when==='object'&&rule.when!==null && Object.entries(rule.when).every(([selector,state])=>EQ(states[selector],state)));
  // Most specific first; equally-specific competing contracts must not be silently selected.
  matched.sort((a,b)=>Object.keys(b.when).length-Object.keys(a.when).length);
  if(!matched.length)return {status:'UNKNOWN',reason:'No independent matching rule'};
  if(matched.length>1&&Object.keys(matched[0].when).length===Object.keys(matched[1].when).length)
    return {status:'UNKNOWN',reason:'Ambiguous independent rules'};
  if(!Array.isArray(matched[0].assertions)||!matched[0].assertions.length)return {status:'UNKNOWN',reason:'Rule lacks assertions'};
  return {status:'READY',rule:matched[0]};
}
export async function runCombinationCases(browser,group,{pageUrl=null,submitSelector=null,rules=[],maxCases=MAX_CASES,reset=null,acknowledgeDisposableEnvironment=false}={}){
  if(acknowledgeDisposableEnvironment!==true)throw new Error('Combination actions require explicit disposable test environment authorization');
  if(!pageUrl&&typeof reset!=='function')throw new Error('Independent reset required for every combination');
  if(pageUrl&&!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(pageUrl))throw new Error('Combination executor accepts localhost test URLs only');
  if(submitSelector!==null&&typeof submitSelector!=='string')throw new Error('submitSelector must be a CSS selector');
  for(const rule of rules)for(const assertion of rule.assertions||[])if(!ALLOWED_ASSERTIONS.has(assertion.action))throw new Error('Only read-only expect* assertions are allowed in combination contracts');
  const cases=[],limit=Math.max(1,Math.min(MAX_CASES,maxCases));
  for(const scenario of group.scenarios.slice(0,limit)){
    const rule=selectRules(scenario.assignments,rules);
    const result={id:scenario.id,states:scenario.assignments.map(a=>({selector:a.selector,state:a.state})),status:'NOT_TESTED',assertions:[],oracleSource:'independent-contract'};
    if(rule.status!=='READY'){result.status='UNKNOWN';result.reason=rule.reason;cases.push(result);continue;}
    if(scenario.assignments.some(a=>!a.selector||a.value==='first-available-option')){result.status='UNKNOWN';result.reason='Unstable selector or unsupported selection operation';cases.push(result);continue;}
    try{
      if(typeof reset==='function')await reset(browser,scenario);
      else await browser.navigate(pageUrl);
      for(const a of scenario.assignments.filter(x=>x.kind!=='action')){
        const isBoolean=typeof a.value==='boolean';
        if(isBoolean){
          const state=await browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(a.selector)});return n?!!n.checked:null;})()`);
          if(state===null)throw new Error(`Input not found: ${a.selector}`);
          if(state!==a.value)await browser.click(a.selector);
        }else await browser.fill(a.selector,a.value);
      }
      for(const a of scenario.assignments.filter(x=>x.kind==='action'&&x.state==='activate'))await browser.click(a.selector);
      if(submitSelector&&!scenario.assignments.some(a=>a.kind==='action'&&a.state==='activate'&&a.selector===submitSelector))await browser.click(submitSelector);
      for(const assertion of rule.rule.assertions){
        const evaluated=await executeStep(browser,assertion);
        result.assertions.push({action:assertion.action,selector:assertion.selector??null,pass:evaluated?.pass??null,actual:evaluated?.actual??null,expected:evaluated?.expected??null,reason:evaluated?.reason??null});
      }
      result.status=result.assertions.some(x=>x.pass===false)?'FAIL':result.assertions.some(x=>x.pass!==true)?'UNKNOWN':'PASS';
    }catch(error){result.status='SUSPECT';result.error=String(error.message||error);}
    cases.push(result);
  }
  return {group:group.group,summary:{planned:group.scenarios.length,executed:cases.filter(x=>['PASS','FAIL','SUSPECT'].includes(x.status)).length,passed:cases.filter(x=>x.status==='PASS').length,failed:cases.filter(x=>x.status==='FAIL').length,unknown:cases.filter(x=>x.status==='UNKNOWN').length,suspect:cases.filter(x=>x.status==='SUSPECT').length,pairwiseCoverage:`${group.coveredPairs}/${group.totalPairs}`},cases,limitations:['Independent user-approved assertion rules, not application source code, define expected behavior.','Cross-field constraints may make generated combinations invalid; add contract rules to distinguish invalid and expected error outcomes.','Only exact CSS selectors and simple input actions are supported; this does not exhaust React/Vue state combinations.']};
}
