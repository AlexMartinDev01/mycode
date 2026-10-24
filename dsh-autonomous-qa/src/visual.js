/** In-browser visual geometry audit; deterministic findings are distinguished from suspects. */
export async function auditVisual(browser,{maxNodes=3000}={}) {
  const result=await browser.evaluate(`(()=>{
    const all=[...document.querySelectorAll('body *')].slice(0,${Number(maxNodes)});
    const issues=[];
    const cssPath=(e)=>{if(e.id)return '#'+CSS.escape(e.id);let p=[],i=0;while(e&&e.nodeType===1&&i++<5){let s=e.tagName.toLowerCase();if(e.classList?.length)s+='.'+CSS.escape(e.classList[0]);p.unshift(s);e=e.parentElement;}return p.join(' > ')};
    const viewport={width:innerWidth,height:innerHeight};
    if(document.documentElement.scrollWidth>innerWidth+2)issues.push({type:'horizontal-overflow',verdict:'SUSPECT',selector:'html',detail:{scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}});
    const parse=(s)=>{let m=s?.match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const a=m[1].split(',').map(Number);return a.length>=3?[a[0],a[1],a[2],a[3]??1]:null;};
    const lum=a=>{const t=a.slice(0,3).map(v=>{let x=v/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;});return 0.2126*t[0]+0.7152*t[1]+0.0722*t[2];};
    for(const e of all){
      const r=e.getBoundingClientRect(),s=getComputedStyle(e),sel=cssPath(e);
      if(s.display==='none'||s.visibility==='hidden'||r.width===0||r.height===0)continue;
      if(e.tagName==='IMG'&&e.complete&&e.naturalWidth===0)issues.push({type:'image-load-failed',verdict:'FAIL',selector:sel,detail:{src:e.getAttribute('src')}});
      if(e.children.length===0 && e.scrollWidth>e.clientWidth+4 && ['hidden','clip'].includes(s.overflowX) && e.clientWidth>0)issues.push({type:'text-clipped',verdict:'SUSPECT',selector:sel,detail:{scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}});
      if(e.matches('button,input,select,textarea,a[href],[role="button"]')&&s.pointerEvents!=='none'&&r.width>0&&r.height>0){
        const x=Math.min(innerWidth-1,Math.max(0,r.left+r.width/2)),y=Math.min(innerHeight-1,Math.max(0,r.top+r.height/2));
        if(x>0&&y>0&&x<innerWidth&&y<innerHeight){let hit=document.elementFromPoint(x,y);if(hit&&hit!==e&&!e.contains(hit)&&!e.disabled)issues.push({type:'interactive-obstructed',verdict:'SUSPECT',selector:sel,detail:{hit:cssPath(hit),x,y}});}
        if(r.width<24||r.height<24)issues.push({type:'small-click-target',verdict:'SUSPECT',selector:sel,detail:{width:Math.round(r.width),height:Math.round(r.height)}});
      }
      if(e.children.length===0&&e.textContent?.trim().length&&r.width>=2&&r.height>=2){
        let fg=parse(s.color),bg=parse(s.backgroundColor);let ancestor=e.parentElement;
        while((!bg||bg[3]<0.99)&&ancestor){const a=parse(getComputedStyle(ancestor).backgroundColor);if(a&&a[3]===1){bg=a;break;}ancestor=ancestor.parentElement;}
        if(fg&&bg&&fg[3]===1&&bg[3]===1){const l1=lum(fg),l2=lum(bg),ratio=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
          if(ratio<4.5&&parseFloat(s.fontSize)<24)issues.push({type:'contrast-suspect',verdict:'SUSPECT',selector:sel,detail:{ratio:Number(ratio.toFixed(2)),color:s.color,background:s.backgroundColor}});
        }
      }
    }
    return {viewport,visited:all.length,total:document.querySelectorAll('body *').length,issues:issues.slice(0,250)};
  })()`);
  return result;
}

export async function enrichVisualFindings(browser,issues,{limit=15}={}) {
  for(const issue of issues.slice(0,limit)) {
    if(issue.selector?.startsWith('html'))continue;
    try{issue.cssEvidence=await browser.cssFor(issue.selector);}catch(e){issue.cssEvidenceError=String(e.message);}
  }
  return issues;
}
