/** Project-aware, conservative symbol and call linkage. This is NOT full dataflow/alias analysis. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { enumerateFiles } from './scanner.js';
const CODE_EXT=/\.(?:[cm]?[jt]sx?|vue)$/i;
const rel=(root,p)=>path.relative(root,p).split(path.sep).join('/');
function asSource(text,file){
  if(!file.endsWith('.vue'))return text;
  // Preserve original source offsets/line numbers while omitting template/style content.
  const chars=text.replace(/[^\n]/g,' ').split('');
  for(const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){
    const start=m.index+m[0].indexOf(m[1]);
    for(let i=0;i<m[1].length;i++)chars[start+i]=m[1][i];
  }
  return chars.join('');
}
function configFor(root){
  const cfg=['tsconfig.json','jsconfig.json'].map(x=>path.join(root,x)).find(p=>fs.existsSync(p));
  if(!cfg)return {baseUrl:root,allowJs:true,jsx:ts.JsxEmit.Preserve,moduleResolution:ts.ModuleResolutionKind.Bundler};
  const c=ts.readConfigFile(cfg,ts.sys.readFile);
  if(c.error)return {baseUrl:root,allowJs:true};
  const parsed=ts.parseJsonConfigFileContent(c.config,ts.sys,path.dirname(cfg));
  return {...parsed.options,allowJs:true};
}
function symbolName(node,src){
  if(ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node))return node.name?.getText(src)||null;
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&(ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer)))return node.name.text;
  return null;
}
export function buildSemanticIndex(projectRoot){
  const root=fs.realpathSync(projectRoot), {files}=enumerateFiles(root);
  const options=configFor(root);
  const sourceFiles=files.filter(f=>CODE_EXT.test(f));
  const set=new Set(sourceFiles.map(p=>path.resolve(p)));
  const records=[],symbols=[],calls=[],links=[],events=[],unresolved=[],domBindings=[];
  const symbolByKey=new Map(), recordByFile=new Map();
  for(const absolute of sourceFiles){
    const file=rel(root,absolute),text=fs.readFileSync(absolute,'utf8');
    const source=ts.createSourceFile(file,asSource(text,file),ts.ScriptTarget.Latest,true,/\.tsx?$/.test(file)?ts.ScriptKind.TSX: /\.jsx$/.test(file)?ts.ScriptKind.JSX:ts.ScriptKind.TS);
    const bindings={},exports=[],locals=[],callsHere=[];
    function pos(n){return source.getLineAndCharacterOfPosition(n.getStart(source)).line+1;}
    function addSymbol(name,node){if(!name)return;
      const s={file,name,line:pos(node),endLine:source.getLineAndCharacterOfPosition(node.end).line+1,key:`${file}#${name}`};
      symbols.push(s);locals.push(s);symbolByKey.set(s.key,s);
    }
    function walk(node,scope=null){
      const nm=symbolName(node,source);
      if(nm)addSymbol(nm,node);
      const nextScope=nm||scope;
      if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
        const specifier=node.moduleSpecifier.text;
        const resolved=ts.resolveModuleName(specifier,absolute,options,ts.sys).resolvedModule?.resolvedFileName;
        const target=resolved&&set.has(path.resolve(resolved))?rel(root,resolved):null;
        const bindingsToAdd=[];
        const clause=node.importClause;
        if(clause?.name)bindingsToAdd.push({local:clause.name.text,imported:'default'});
        const named=clause?.namedBindings;
        if(named&&ts.isNamespaceImport(named))bindingsToAdd.push({local:named.name.text,imported:'*'});
        if(named&&ts.isNamedImports(named))for(const el of named.elements)bindingsToAdd.push({local:el.name.text,imported:el.propertyName?.text||el.name.text});
        for(const b of bindingsToAdd)bindings[b.local]={target,imported:b.imported,specifier,line:pos(node)};
        if(!target&&specifier.startsWith('.'))unresolved.push({file,line:pos(node),specifier,reason:'not resolved inside scan'});
      }
      if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))exports.push({kind:'reexport',specifier:node.moduleSpecifier.text,line:pos(node)});
      if(ts.isCallExpression(node)){
        const exp=node.expression;
        const callee=exp.getText(source);
        const call={file,line:pos(node),caller:scope||'<module>',callee,kind:'unknown',target:null,targetSymbol:null};
        if(ts.isIdentifier(exp))call.identifier=exp.text;
        else if(ts.isPropertyAccessExpression(exp)&&ts.isIdentifier(exp.expression)){call.receiver=exp.expression.text;call.method=exp.name.text;}
        calls.push(call);callsHere.push(call);
        if((callee.endsWith('.querySelector')||callee.endsWith('.getElementById'))&&ts.isStringLiteral(node.arguments[0])){
          domBindings.push({file,line:pos(node),selector:node.arguments[0].text,operation:callee});
        }
        if(callee.endsWith('.addEventListener')&&ts.isStringLiteral(node.arguments[0])){
          events.push({file,line:pos(node),event:node.arguments[0].text,receiver:callee.slice(0,-'.addEventListener'.length),handler:node.arguments[1]?.getText(source).slice(0,100)||null,caller:scope||'<module>'});
        }
      }
      ts.forEachChild(node,child=>walk(child,nextScope));
    }
    walk(source);
    const record={file,absolute,bindings,locals,calls:callsHere,exports};
    records.push(record);recordByFile.set(file,record);
  }
  for(const call of calls){
    const record=recordByFile.get(call.file);
    let target=null,kind='unresolved';
    if(call.identifier){
      const bind=record.bindings[call.identifier];
      if(bind?.target){target=`${bind.target}#${bind.imported}`;kind='imported-call';}
      else if(symbolByKey.has(`${call.file}#${call.identifier}`)){target=`${call.file}#${call.identifier}`;kind='local-call';}
      else if(bind){kind='external-import';}
    } else if(call.receiver){
      const bind=record.bindings[call.receiver];
      if(bind?.target&&bind.imported==='*'){target=`${bind.target}#${call.method}`;kind='namespace-call';}
    }
    call.kind=kind;
    if(target&&symbolByKey.has(target)){
      call.target=target.split('#')[0];call.targetSymbol=target.split('#')[1];call.targetLine=symbolByKey.get(target).line;
      links.push({from:`${call.file}#${call.caller}`,to:target,file:call.file,line:call.line,kind});
    } else if(target){unresolved.push({file:call.file,line:call.line,callee:call.callee,reason:'target symbol not indexed'});}
  }
  return {
    projectRoot:root,summary:{files:records.length,symbols:symbols.length,calls:calls.length,resolvedCalls:links.length,unresolved:unresolved.length,domReferences:domBindings.length},
    symbols,calls,links,events,domBindings,unresolved,
    // Avoid exposing absolute paths / redundant parse state to model calls.
    imports:records.flatMap(r=>Object.entries(r.bindings).map(([local,b])=>({file:r.file,local,...b})))
  };
}
/** Bounded graph walk with source-line evidence; unknown dynamic edges stay unverified. */
export function traceCalls(index,{file,symbol,maxDepth=8}={}){
  if(!file||!symbol)throw new Error('file and symbol are required');
  const key=`${file}#${symbol}`,visited=new Set(),edges=[];
  function dfs(from,depth){if(depth>maxDepth||visited.has(from))return;visited.add(from);
    for(const e of index.links.filter(e=>e.from===from)){edges.push({...e,depth});dfs(e.to,depth+1);}
  }
  dfs(key,0);
  return {start:key,edges,visited:[...visited],complete:false,limitation:'Only resolvable direct calls are linked; dynamic dispatch, closures, effects and type-level aliasing need runtime evidence.'};
}
