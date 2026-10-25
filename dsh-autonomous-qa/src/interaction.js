/** Bounded runtime evidence for a single browser interaction.
 * DOM diffs are observations, not independently validated correctness or a causal source-line proof.
 */
import {executeStep} from './engine.js';
const SUPPORTED=new Set(['click','fill','selectOption']);
const ORACLES=new Set(['expectText','expectValue','expectVisible','expectUrl','expectStyle','expectNumber','expectDerived','expectAttribute','expectCount','expectNetwork','expectLayout','expectEventually']);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function captureInteractionState(browser,selectors=[]){
  if(!Array.isArray(selectors)||selectors.length>40||selectors.some(x=>typeof x!=='string'||x.length>250))throw new Error('selectors must contain at most 40 CSS selectors');
  return browser.evaluate(`(()=>{
    const sels=${JSON.stringify(selectors)},out={url:location.href,nodes:{}};
    for(const sel of sels){let e;try{e=document.querySelector(sel)}catch{out.nodes[sel]={status:'INVALID_SELECTOR'};continue;}
      if(!e){out.nodes[sel]={status:'MISSING'};continue;}
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      const secret=e.matches('input[type="password"],input[type="hidden"],input[autocomplete="one-time-code"],input[autocomplete="cc-number"]')||/(password|passwd|token|secret|otp|ssn|card|api[_-]?key)/i.test([e.id,e.name,e.getAttribute('autocomplete')].join(' '));
      out.nodes[sel]={status:'PRESENT',tag:e.tagName,visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden',
        // Never read password or sensitive input values into evidence.
        text:e.matches('input,textarea,select')?null:(e.innerText||'').slice(0,300),
        value:secret?'[REDACTED]':(e.matches('input,textarea,select')?String(e.value).slice(0,250):null),
        checked:e.matches('input[type="checkbox"],input[type="radio"]')?e.checked:null,
        disabled:e.matches(':disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height},
        styles:{display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,zIndex:s.zIndex,color:s.color,background:s.backgroundColor,pointerEvents:s.pointerEvents}};
    }
    return out;
  })()`);
}
export async function traceInteraction(browser,{action,selector,value,observeSelectors=[],assertions=[],settleMs=100}={}){
  if(!SUPPORTED.has(action)||typeof selector!=='string')throw new Error('Interaction must be click, fill or selectOption with selector');
  if(!Array.isArray(assertions)||assertions.length>15||assertions.some(a=>!a||!ORACLES.has(a.action)||(a.action==='expectEventually'&&(!a.assertion||!ORACLES.has(a.assertion.action)||a.assertion.action==='expectEventually'))))throw new Error('Only read-only assertions allowed');
  const sels=[...new Set([selector,...observeSelectors])];
  const before=await captureInteractionState(browser,sels);
  const logStart={exceptions:browser.logs.exceptions.length,network:browser.logs.network.length,console:browser.logs.console.length};
  let observation=null,error=null;
  try{
    if(action==='click')observation=await browser.click(selector);
    else if(action==='fill')observation=await browser.fill(selector,value??'');
    else observation=await browser.selectOption(selector,value);
  }catch(e){error=String(e.message||e);}
  await wait(Math.min(2500,Math.max(0,Number(settleMs)||0)));
  const after=await captureInteractionState(browser,sels);
  const changed=Object.keys(after.nodes).filter(sel=>JSON.stringify(before.nodes[sel])!==JSON.stringify(after.nodes[sel]));
  if(before.nodes[selector]?.value==='[REDACTED]' && observation && 'value' in observation)observation.value='[REDACTED]';
  const checks=[];
  if(!error)for(const a of assertions){
    try{const r=await executeStep(browser,a);checks.push({action:a.action,selector:a.selector||null,pass:r?.pass??null,reason:r?.reason??null,actual:r?.actual??null,expected:r?.expected??null});}
    catch(e){checks.push({action:a.action,pass:null,error:String(e.message||e)});}
  }
  const verdict=error?'SUSPECT':!checks.length?'UNKNOWN':checks.some(c=>c.pass===false)?'FAIL':checks.some(c=>c.pass!==true)?'UNKNOWN':'PASS';
  return {action,selector,verdict,error,before,after,changed,observation,
    runtimeEvidence:{exceptions:browser.logs.exceptions.slice(logStart.exceptions),network:browser.logs.network.slice(logStart.network),console:browser.logs.console.slice(logStart.console)},
    assertions:checks,limitations:['DOM changes do not establish business correctness without independent assertions.','CSS geometries and runtime observations cannot by themselves prove an exact causal source line.']};
}
