/** Bounded markup/JSX interaction index. Findings are static hypotheses, not runtime proof. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {enumerateFiles} from './scanner.js';
import {buildSemanticIndex} from './semantic.js';

const MARKUP=/\.(?:html?|vue|jsx|tsx)$/i;
const MAX_NODES=15000;
const MAX_CASES=64;
const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const CONTROL=new Set(['input','select','textarea','button','form','a','option']);
const posAt=(src,offset)=>{const pre=src.slice(0,offset);return {line:pre.split('\n').length,column:offset-(pre.lastIndexOf('\n')+1)+1};};
const fileRel=(root,f)=>path.relative(root,f).split(path.sep).join('/');
const pushUnique=(arr,item)=>{if(!arr.includes(item))arr.push(item);};
function findRefs(expr){
  if(!expr)return [];
  const blacklist=new Set(['true','false','null','undefined','return','function','async','await','event','$event','this','Math','Number','String','Boolean','Array','Object','console','window','document','length']);
  const out=[];
  for(const match of String(expr).matchAll(/\b[$A-Za-z_][$\w]*\b/g)){
    const id=match[0],start=match.index;
    if(blacklist.has(id)||/\d/.test(id[0])||expr[start-1]==='.'||id==='v'||id==='on')continue;
    pushUnique(out,id);
  }
  return out.slice(0,24);
}
function attrsFromText(text,base){
  const attrs=[];
  // Quotes may contain > and whitespace; unquoted values stop at whitespace.
  const attrRe=/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for(const m of text.matchAll(attrRe)){
    const name=m[1],value=m[2]??m[3]??m[4]??null;
    if(name==='/'||name==='<')continue;
    attrs.push({name,value,offset:base+m.index});
  }
  return attrs;
}
function scanTags(template,offset,fullText,diagnostics){
  const found=[],stack=[];
  for(let i=0;i<template.length;){
    if(template.startsWith('<!--',i)){const end=template.indexOf('-->',i+4);i=end<0?template.length:end+3;continue;}
    if(template[i]!=='<'){i++;continue;}
    if(template.startsWith('<!',i)||template.startsWith('<?',i)){const e=template.indexOf('>',i+2);i=e<0?template.length:e+1;continue;}
    let p=i+1,close=false;
    if(template[p]==='/'){close=true;p++;}
    const tagMatch=/^[\p{L}_][\p{L}0-9_:.\-]*/u.exec(template.slice(p));
    if(!tagMatch){i++;continue;}
    const tag=tagMatch[0];p+=tag.length;
    const attrStart=p;let quote=null;let brace=0;
    // Do not prematurely terminate at a quoted `>`.
    while(p<template.length){
      const c=template[p];
      if(quote){if(c===quote&&template[p-1]!=='\\')quote=null;}
      else if(c==='"'||c==="'")quote=c;
      else if(c==='{')brace++;
      else if(c==='}'&&brace)brace--;
      else if(c==='>'&&!brace)break;
      p++;
    }
    if(p>=template.length){diagnostics.push({line:posAt(fullText,offset+i).line,type:'incomplete-tag',tag});break;}
    const rawAttrs=template.slice(attrStart,p);
    const unary=/\/\s*$/.test(rawAttrs)||VOID.has(tag.toLowerCase());
    if(close){
      const k=stack.map(s=>s.tag.toLowerCase()).lastIndexOf(tag.toLowerCase());
      if(k>=0)stack.length=k;else diagnostics.push({line:posAt(fullText,offset+i).line,type:'unmatched-close',tag});
    }else{
      const parent=stack.length?stack[stack.length-1].id:null;
      const attrs=attrsFromText(rawAttrs,offset+attrStart);
      const node={tag,offset:offset+i,attributes:attrs,parent,kind:'html',conditions:[]};
      found.push(node);
      node.id=`tag_${found.length}`;
      if(!unary)stack.push(node);
    }
    i=p+1;
    // Non-markup script/style content is opaque until matching closing tag.
    if(!close&&['script','style'].includes(tag.toLowerCase())){
      const tail=template.slice(i).toLowerCase(),at=tail.indexOf(`</${tag.toLowerCase()}`);
      if(at>=0)i+=at;
    }
  }
  return found;
}
function scanVueOrHtml(file,source){
  let segments=[];
  if(file.endsWith('.vue')){
    // Balance nested <template> tags (Vue slots/conditions) instead of stopping at the first inner </template>.
    const matches=[...source.matchAll(/<\/?template\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
    let depth=0,start=null;
    for(const match of matches){
      const closing=/^<\//.test(match[0]);
      if(!closing){if(depth===0)start=match.index+match[0].length;depth++;}
      else if(depth>0){depth--;if(depth===0&&start!==null){segments.push({text:source.slice(start,match.index),offset:start});start=null;}}
    }
  }else segments=[{text:source,offset:0}];
  const nodes=[],diagnostics=[];
  for(const s of segments){const n=scanTags(s.text,s.offset,source,diagnostics);const mapping=new Map();
    for(const item of n){const old=item.id;item.id=`tag_${nodes.length+1}`;
      if(item.parent)item.parent=mapping.get(item.parent)||null;
      mapping.set(old,item.id);nodes.push(item);
    }
  }
  return {nodes,diagnostics};
}

function scanJsx(file,source){
  const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const nodes=[],diagnostics=(parsed.parseDiagnostics||[]).map(d=>({line:parsed.getLineAndCharacterOfPosition(d.start||0).line+1,type:'jsx-parse',message:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
  function ancestorConditions(node){
    const conditions=[];let p=node.parent;
    while(p){
      if(ts.isConditionalExpression(p)){pushUnique(conditions,p.condition.getText(parsed));}
      if(ts.isBinaryExpression(p)&&p.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken){pushUnique(conditions,p.left.getText(parsed));}
      p=p.parent;
    }
    return conditions.slice(0,10);
  }
  function walk(node,owner=null){
    if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)){
      const opening=ts.isJsxElement(node)?node.openingElement:node;
      const name=opening.tagName.getText(parsed);const attrs=[];
      for(const prop of opening.attributes.properties){
        if(ts.isJsxAttribute(prop)){
          const name=prop.name.getText(parsed);
          const val=prop.initializer?(ts.isStringLiteral(prop.initializer)?prop.initializer.text:
            ts.isJsxExpression(prop.initializer)?prop.initializer.expression?.getText(parsed)??'':prop.initializer.getText(parsed)):null;
          attrs.push({name,value:val,offset:prop.getStart(parsed)});
        }else if(ts.isJsxSpreadAttribute(prop))attrs.push({name:'...spread',value:prop.expression.getText(parsed),offset:prop.getStart(parsed)});
      }
      const result={tag:name,attributes:attrs,offset:opening.getStart(parsed),parent:owner,kind:'jsx',conditions:ancestorConditions(node),id:`tag_${nodes.length+1}`};
      nodes.push(result);owner=result.id;
      if(ts.isJsxElement(node)){for(const child of node.children)walk(child,owner);}
      return;
    }
    ts.forEachChild(node,n=>walk(n,owner));
  }
  walk(parsed);
  return {nodes,diagnostics};
}
function refine(file,source,nodes){
  for(const n of nodes){
    const {line,column}=posAt(source,n.offset);
    n.file=file;n.line=line;n.column=column;n.key=`${file}:${line}:${column}:${n.id}`;
    const attrs=Object.fromEntries(n.attributes.map(a=>[a.name,a.value]));
    const events=[],bindings=[],conditions=[...n.conditions];
    for(const a of n.attributes){
      const p=posAt(source,a.offset);a.line=p.line;a.column=p.column;delete a.offset;
      if(/^@[^\s]+$/.test(a.name)||/^v-on:/.test(a.name)||/^on[A-Z]/.test(a.name)||/^on(?:click|change|input|submit|blur|focus|keydown|keyup|mousedown|mouseup|pointerdown|pointerup)$/i.test(a.name))events.push({event:a.name.replace(/^@/,'').replace(/^v-on:/,'').replace(/^on/,''),handler:a.value,line:a.line,refs:findRefs(a.value)});
      if(/^(?:v-model(?:\.[\w]+)*|v-bind:|:|bind:)/.test(a.name)||(/^[\w-]+$/.test(a.name)&&n.kind==='jsx'&&a.value!==null&&!['id','name','type','value','placeholder','data-testid','aria-label'].includes(a.name)))bindings.push({name:a.name,expression:a.value,line:a.line,refs:findRefs(a.value)});
      if(['v-if','v-else-if','v-show','v-for','hidden','disabled','required'].includes(a.name)||a.name.startsWith('v-if:'))conditions.push(`${a.name}${a.value===null?'':`=${a.value}`}`);
    }
    const exact=attrs.id?`#${String(attrs.id).replace(/([#.;?+*~':"!^$[\]()=>|/@])/g,'\\$1')}`:attrs['data-testid']?`[data-testid=${JSON.stringify(attrs['data-testid'])}]`:null;
    n.selector=exact;
    n.events=events;n.bindings=bindings;n.conditions=conditions;
    n.tagType=CONTROL.has(n.tag.toLowerCase())?'control':/^[A-Z]/.test(n.tag)||n.tag.includes('-')?'component':'element';
    n.refs=[...new Set([...events.flatMap(x=>x.refs),...bindings.flatMap(x=>x.refs),...conditions.flatMap(findRefs)])].slice(0,30);
    delete n.offset;
  }
  const remap=new Map(nodes.map(x=>[x.id,x.key]));
  for(const node of nodes)if(node.parent)node.parent=remap.get(node.parent)||null;
  return nodes;
}
export function buildMarkupIndex(projectRoot,{maxNodes=MAX_NODES}={}){
  const root=fs.realpathSync(projectRoot),{files}=enumerateFiles(root);
  const nodes=[],diagnostics=[],filesAnalyzed=[];
  const cap=Math.max(1,Math.min(MAX_NODES,maxNodes));
  for(const absolute of files.filter(f=>MARKUP.test(f))){
    const file=fileRel(root,absolute),source=fs.readFileSync(absolute,'utf8');
    const parsed=/\.(?:jsx|tsx)$/i.test(file)?scanJsx(file,source):scanVueOrHtml(file,source);
    filesAnalyzed.push(file);
    for(const d of parsed.diagnostics)diagnostics.push({file,...d});
    if(nodes.length+parsed.nodes.length>cap){diagnostics.push({file,type:'node-limit',maxNodes:cap});break;}
    nodes.push(...refine(file,source,parsed.nodes));
  }
  const semantic=buildSemanticIndex(root),symbols=new Map(semantic.symbols.map(s=>[s.key,s]));
  const imports=new Map();for(const i of semantic.imports){if(!imports.has(i.file))imports.set(i.file,new Map());imports.get(i.file).set(i.local,i);}
  const edges=[];const add=(from,to,kind,detail={})=>edges.push({from,to,kind,...detail});
  const tagsByFile=new Map();for(const n of nodes){if(!tagsByFile.has(n.file))tagsByFile.set(n.file,[]);tagsByFile.get(n.file).push(n);}
  for(const node of nodes){
    if(node.parent){const p=tagsByFile.get(node.file)?.find(n=>n.key===node.parent);if(p)add(p.key,node.key,'contains');}
    for(const ev of node.events){
      const handler=String(ev.handler||'').trim();const target=handler.match(/^[\w$]+(?:\s*\(.*\))?$/)?.[0]?.split('(')[0];
      if(!target)continue;
      const local=symbols.get(`${node.file}#${target}`), imp=imports.get(node.file)?.get(target);
      if(local)add(node.key,local.key,'event-handler',{line:ev.line,evidence:'static-direct-reference'});
      else if(imp?.target){const key=`${imp.target}#${imp.imported}`;
        if(symbols.has(key))add(node.key,key,'event-handler',{line:ev.line,evidence:'static-import-reference'});
      }
    }
    for(const bound of node.bindings)for(const ref of bound.refs){
      const key=`${node.file}#${ref}`;
      if(symbols.has(key))add(node.key,key,'binding-symbol',{line:bound.line});
    }
    for(const ref of node.refs){
      add(node.key,`${node.file}#state:${ref}`,'references-state',{evidence:'lexical-reference-only',verified:false});
    }
    if(node.tagType==='component'){
      const imported=imports.get(node.file)?.get(node.tag);
      if(imported?.target)add(node.key,imported.target,'component-import',{line:node.line,confidence:'import-only; render/prop effects unknown'});
    }
  }
  const refsToNodes=new Map();for(const n of nodes)for(const ref of n.refs){const k=`${n.file}#state:${ref}`;if(!refsToNodes.has(k))refsToNodes.set(k,[]);refsToNodes.get(k).push(n.key);}
  for(const [state,users] of refsToNodes)for(let i=0;i<users.length;i++)for(let j=i+1;j<users.length&&j<i+25;j++)add(users[i],users[j],'shared-state-reference',{via:state,evidence:'lexical-only',verified:false});
  return {projectRoot:root,summary:{files:filesAnalyzed.length,tags:nodes.length,controls:nodes.filter(n=>n.tagType==='control').length,events:nodes.reduce((a,n)=>a+n.events.length,0),bindings:nodes.reduce((a,n)=>a+n.bindings.length,0),conditions:nodes.reduce((a,n)=>a+n.conditions.length,0),edges:edges.length,parseDiagnostics:diagnostics.length},filesAnalyzed,nodes,edges,diagnostics,limitations:['Vue templates use a bounded tokenizer, not a complete Vue compiler AST.','JSX is parsed with TypeScript AST; dynamic spread props, runtime aliases and custom component rendering are unresolved.','An event handler edge is a static reference, not proof of execution or business correctness.','Unconditional tags may be absent on routes or runtime states; observed absence alone is not a bug.']};
}
function levelsFor(node){
  const a=Object.fromEntries(node.attributes.map(a=>[a.name,a.value]));
  const type=(a.type||node.tag).toLowerCase();
  if(['checkbox','radio'].includes(type))return [{id:'unchecked',value:false},{id:'checked',value:true}];
  if(type==='number')return [{id:'empty',value:''},{id:'zero',value:'0'},{id:'positive',value:'1'},{id:'negative',value:'-1'}];
  if(node.tag.toLowerCase()==='select')return [{id:'none',value:''},{id:'selected',value:'first-available-option'}];
  if(type==='email')return [{id:'empty',value:''},{id:'valid',value:'qa@example.test'},{id:'invalid',value:'not-an-email'}];
  return [{id:'empty',value:''},{id:'typical',value:'QA sample'},{id:'boundary',value:'x'.repeat(64)}];
}
/** Deterministic pairwise scenarios. No business oracle is inferred from implementation. */
export function planTagCombinations(markup,{file,maxCases=32,contracts={}}={}){
  const max=Math.max(1,Math.min(MAX_CASES,maxCases));
  const nodes=markup.nodes.filter(n=>(!file||n.file===file));
  const groups=[];
  const forms=nodes.filter(n=>n.tag.toLowerCase()==='form');
  const parentOf=(node)=>{const map=new Map(nodes.map(n=>[n.key,n]));let cur=node.parent;while(cur){const p=map.get(cur);if(!p)break;if(p.tag.toLowerCase()==='form')return p.key;cur=p.parent;}return `${node.file}#page`;};
  const groupMap=new Map();
  for(const n of nodes){
    const low=n.tag.toLowerCase();const isField=['input','select','textarea'].includes(low);const isAction=['button','a'].includes(low)||n.events.some(e=>/click/i.test(e.event));
    if(!isField&&!isAction)continue;
    const groupId=parentOf(n);if(!groupMap.has(groupId))groupMap.set(groupId,[]);
    groupMap.get(groupId).push(n);
  }
  for(const [groupId,fields] of groupMap){
    const inputFields=fields.filter(n=>['input','select','textarea'].includes(n.tag.toLowerCase()));
    const actionNodes=fields.filter(n=>!['input','select','textarea'].includes(n.tag.toLowerCase()));
    const factors=[...inputFields,...actionNodes].slice(0,12).map(n=>({node:n.key,tag:n.tag,selector:n.selector,kind:['input','select','textarea'].includes(n.tag.toLowerCase())?'input':'action',risk:1+Math.min(3,n.events.length)+Math.min(3,n.conditions.length)+Math.min(2,n.bindings.length),levels:['input','select','textarea'].includes(n.tag.toLowerCase())?levelsFor(n):[{id:'idle',value:'not-triggered'},{id:'activate',value:'activate'}],file:n.file,line:n.line}));
    const scenarios=[],remaining=new Set();
    for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)for(let a=0;a<factors[i].levels.length;a++)for(let b=0;b<factors[j].levels.length;b++)remaining.add(`${i}:${a}|${j}:${b}`);
    const scenariosKeys=new Set();
    function add(indices,reason){const key=indices.join(',');if(scenariosKeys.has(key)||scenarios.length>=max)return false;
      scenariosKeys.add(key);
      const assignments=factors.map((f,i)=>({node:f.node,selector:f.selector,kind:f.kind,source:{file:f.file,line:f.line},state:f.levels[indices[i]].id,value:f.levels[indices[i]].value}));
      const contract=contracts[groupId]||null;
      scenarios.push({id:`${groupId}#case-${scenarios.length+1}`,group:groupId,reason,assignments,verdict:'NOT_TESTED',expected:contract?.expected??null,oracleStatus:contract?.expected!==undefined?'PROVIDED':'UNKNOWN',executable:assignments.every(a=>typeof a.selector==='string')&&contract?.expected!==undefined});
      for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)remaining.delete(`${i}:${indices[i]}|${j}:${indices[j]}`);
      return true;
    }
    const baseline=factors.map(f=>Math.min(1,f.levels.length-1));
    add(baseline,'baseline');
    // Preserve single-factor edge values, even if the pairwise budget is exhausted later.
    for(let i=0;i<factors.length&&scenarios.length<max;i++)for(let a=0;a<factors[i].levels.length&&scenarios.length<max;a++){
      const choices=[...baseline];choices[i]=a;add(choices,'single-factor');
    }
    for(let round=0;remaining.size&&scenarios.length<max&&round<max*8;round++){
      let best=null,bestGain=-1;
      // Cover uncovered pairs with deterministic seeded greedy candidates.
      for(let seed=0;seed<Math.min(64,remaining.size+8);seed++){
        const indices=factors.map((f,i)=>(seed+i*5+round*3)%f.levels.length);
        for(const pair of [...remaining].slice(seed,seed+1)){
          if(!pair)continue;
          const m=/^(\d+):(\d+)\|(\d+):(\d+)$/.exec(pair);
          if(m){indices[+m[1]]=+m[2];indices[+m[3]]=+m[4];}
        }
        let gain=0;for(let i=0;i<factors.length;i++)for(let j=i+1;j<factors.length;j++)if(remaining.has(`${i}:${indices[i]}|${j}:${indices[j]}`))gain++;
        if(gain>bestGain){bestGain=gain;best=indices;}
      }
      if(!best||bestGain<=0)break;
      add(best,'pairwise');
    }
    const totalPairs=factors.reduce((sum,f,i)=>sum+factors.slice(i+1).reduce((s,g)=>s+f.levels.length*g.levels.length,0),0);
    const stateDependencies=[...new Set(fields.flatMap(n=>n.refs))].sort();
    groups.push({group:groupId,sourceFile:fields[0]?.file,fields:inputFields.length,actions:actionNodes.length,stateDependencies,factorDefinitions:factors,analyzedFactors:factors.length,truncatedFactors:Math.max(0,fields.length-factors.length),totalPairs,coveredPairs:totalPairs-remaining.size,uncoveredPairs:remaining.size,scenarios,status:'PLAN_ONLY',limitations:['All generated cases are NOT_TESTED until executed against a real browser.','Business assertions require an independent oracle; source code is not a trustworthy expected result.','Cross-field constraints and disabled/conditional controls require runtime checking.']});
  }
  return {summary:{groups:groups.length,scenarios:groups.reduce((a,g)=>a+g.scenarios.length,0),uncoveredPairs:groups.reduce((a,g)=>a+g.uncoveredPairs,0)},groups};
}
