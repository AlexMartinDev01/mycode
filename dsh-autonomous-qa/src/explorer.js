/** Bounded source-aware interaction discovery. Non-destructive exploration is conservative. */
import { auditVisual } from './visual.js';
const DANGEROUS=/(?:delete|remove|destroy|reset|submit|save|purchase|pay|checkout|logout|publish|send|upload|transfer|confirm|删除|移除|重置|提交|保存|购买|支付|退出|注销|发布|上传|转账|确认)/i;
export async function discoverControls(browser,{maxControls=150}={}){
  return await browser.evaluate(`(()=>{
    const r=[];const nodes=[...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[tabindex]')].slice(0,${Math.min(3000,maxControls*10)});
    for(const e of nodes){const b=e.getBoundingClientRect(),s=getComputedStyle(e);if(!b.width||!b.height||s.visibility==='hidden'||s.display==='none')continue;
      const name=(e.innerText||e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('placeholder')||e.value||'').trim().slice(0,100);
      let selector=e.id?'#'+CSS.escape(e.id):null;
      if(!selector){const a=e.getAttribute('data-testid');if(a)selector='[data-testid='+JSON.stringify(a)+']';}
      if(!selector){const path=[];let n=e;while(n&&n!==document.body&&path.length<6){let k=n.tagName.toLowerCase();const index=[...(n.parentElement?.children||[])].filter(s=>s.tagName===n.tagName).indexOf(n)+1;if(index>0)k+= ':nth-of-type('+index+')';path.unshift(k);n=n.parentElement;}selector='body > '+path.join(' > ');}
      r.push({selector,tag:e.tagName.toLowerCase(),type:e.type||null,name,href:e.getAttribute('href'),disabled:!!e.disabled,checked:!!e.checked,rect:{x:b.x,y:b.y,width:b.width,height:b.height}});
      if(r.length>=${maxControls})break;
    }return r;
  })()`);
}
export async function explorePage(browser,{executeSafeClicks=false,maxActions=20,safeBaseUrl=null}={}){
  const controls=await discoverControls(browser);const actions=[];
  const entryUrl=await browser.evaluate('location.href');
  for(const c of controls){
    let safety='REVIEW';
    const text=[c.name,c.href,c.selector].join(' ');
    if(DANGEROUS.test(text))safety='DANGEROUS';
    else if(c.disabled)safety='DISABLED';
    else if(c.tag==='a'&&c.href?.startsWith('#'))safety='SAFE';
    else if(c.tag==='button'&&c.type!=='submit')safety='CONDITIONAL';
    else if(['input','select','textarea'].includes(c.tag))safety='DATA_ENTRY';
    actions.push({...c,safety,execution:'NOT_TESTED'});
  }
  if(executeSafeClicks){
    let used=0;
    for(const act of actions){
      if(used>=maxActions)break;
      if(act.safety!=='SAFE'&&act.safety!=='CONDITIONAL')continue;
      const before={url:await browser.evaluate('location.href'),text:await browser.evaluate('document.body.innerText.slice(0,10000)'),errors:browser.logs.exceptions.length,requests:browser.logs.network.length};
      try{
        const res=await browser.click(act.selector);
        await new Promise(r=>setTimeout(r,100));
        const after={url:await browser.evaluate('location.href'),text:await browser.evaluate('document.body.innerText.slice(0,10000)'),errors:browser.logs.exceptions.length,requests:browser.logs.network.length};
        act.execution='EXECUTED';act.observation={clicked:res.clicked,urlChanged:before.url!==after.url,textChanged:before.text!==after.text,newExceptions:after.errors-before.errors,newNetworkEvents:after.requests-before.requests};
        if(act.observation.newExceptions)act.verdict='SUSPECT';else act.verdict='UNKNOWN'; // No independent oracle.
        used++;
        if(after.url!==entryUrl){
          if(safeBaseUrl && !after.url.startsWith(safeBaseUrl)){act.execution='NAVIGATED_AWAY';break;}
          try{await browser.navigate(entryUrl);}catch(e){act.execution='NAVIGATED_AWAY';break;}
        }
      }catch(e){act.execution='FAILED';act.error=e.message;act.verdict='SUSPECT';used++;}
    }
  }
  const visual=await auditVisual(browser);
  return {url:entryUrl,discovered:controls.length,executed:actions.filter(a=>a.execution!=='NOT_TESTED').length,actions,visual,limitations:['Autonomous observation does not prove business correctness without independent assertions.','Safe-click classifier is conservative but cannot guarantee an operation is side-effect-free.']};
}
