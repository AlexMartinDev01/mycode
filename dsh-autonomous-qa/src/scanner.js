import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';

const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.css', '.scss', '.less', '.html', '.json']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', '.DS_Store']);
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 5000;
const srcKind = file => /\.tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

export function enumerateFiles(root) {
  const realRoot = fs.realpathSync(root);
  const result = []; let skipped = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name) || ent.name.startsWith('.env')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) { skipped.push({path: path.relative(realRoot, full), reason: 'symlink excluded'}); continue; }
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && EXTS.has(path.extname(ent.name).toLowerCase())) {
        if (result.length >= MAX_FILES) throw new Error('Source file limit exceeded (5000)');
        const size = fs.statSync(full).size;
        if (size > MAX_FILE) { skipped.push({path: path.relative(realRoot, full), reason:'file exceeds 1 MiB'}); continue; }
        result.push(full);
      }
    }
  }
  walk(realRoot); result.sort();
  return {root: realRoot, files: result, skipped};
}
function padBefore(source, pos) {return source.slice(0,pos).replace(/[^\n]/g,' ');}
function virtualVueScript(content) {
  const parts = [];
  for (const match of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const start = match.index + match[0].indexOf(match[1]);
    parts.push(padBefore(content, start) + match[1]);
  }
  return parts.length ? parts.join('\n') : '';
}
function scanMarkupEvents(content, file) {
  const events=[];
  for(const m of content.matchAll(/(?:@([\w:-]+)|v-on:([\w:-]+)|\b(onClick|onChange|onSubmit|onInput))\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    events.push({file, line:lineOf(content,m.index), event:m[1]||m[2]||m[3], handler:m[4]||m[5]||m[6]||''});
  }
  return events;
}
function extractVueCss(content, file) {
  const res = [];
  for (const m of content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const off=m.index+m[0].indexOf(m[1]);
    res.push(parseStyles(m[1], file, lineOf(content,off)-1));
  }
  return res.flat();
}
function parseStyles(content, file, offset=0) {
  const rules=[];
  try {
    const root=postcss.parse(content, {from:file});
    root.walkRules(rule=>{
      rules.push({file,line:(rule.source?.start?.line||1)+offset,selector:rule.selector,declarations:rule.nodes.filter(n=>n.type==='decl').map(n=>({property:n.prop,value:n.value,line:(n.source?.start?.line||1)+offset}))});
    });
  } catch(err) { rules.push({file,error:String(err.message),line:offset+(err.line||1)}); }
  return rules;
}
function moduleCandidates(base) {return [base, ...['.ts','.tsx','.js','.jsx','.vue','.json','/index.ts','/index.tsx','/index.js','/index.vue'].map(e=>base+e)];}
function findRelativeImport(absFile, target) {
  if(!target.startsWith('.')) return null;
  return moduleCandidates(path.resolve(path.dirname(absFile),target)).find(p=>fs.existsSync(p)&&fs.statSync(p).isFile())||null;
}
export function scanProject(root) {
  const {root:projectRoot, files, skipped}=enumerateFiles(root);
  const modules=[], edges=[], events=[], styleRules=[], diagnostics=[];
  let config=null;
  const cfg=path.join(projectRoot,'tsconfig.json');
  if (fs.existsSync(cfg)) {
    try {const read=ts.readConfigFile(cfg,ts.sys.readFile); const parsed=ts.parseJsonConfigFileContent(read.config,ts.sys,projectRoot); config={path:'tsconfig.json',compilerOptions:parsed.options};}
    catch(e){diagnostics.push({file:'tsconfig.json',message:String(e)});}
  }
  for(const abs of files) {
    const file=path.relative(projectRoot,abs).split(path.sep).join('/');
    const content=fs.readFileSync(abs,'utf8');
    const ext=path.extname(file).toLowerCase();
    const record={file,lines:content.split('\n').length,kind:ext.slice(1),status:'parsed',functions:[],imports:[],exports:[],identifiers:0};
    if(['.css','.scss','.less'].includes(ext)) styleRules.push(...parseStyles(content,file));
    if(ext==='.vue') {
      events.push(...scanMarkupEvents(content,file));
      styleRules.push(...extractVueCss(content,file));
    }
    if(['.js','.jsx','.ts','.tsx','.vue'].includes(ext)) {
      const parseText=ext==='.vue'?virtualVueScript(content):content;
      let source=ts.createSourceFile(file,parseText,ts.ScriptTarget.Latest,true,ext==='.vue'?ts.ScriptKind.TS:srcKind(file));
      for(const error of source.parseDiagnostics||[]) {
        diagnostics.push({file,line: source.getLineAndCharacterOfPosition(error.start||0).line+1,message:ts.flattenDiagnosticMessageText(error.messageText,' ')});
      }
      function walk(node) {
        if(ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec=node.moduleSpecifier.text;
          const resolved=findRelativeImport(abs,spec);
          const ln=source.getLineAndCharacterOfPosition(node.getStart(source)).line+1;
          record.imports.push({specifier:spec,line:ln,target:resolved?path.relative(projectRoot,resolved).split(path.sep).join('/'):null});
          if (resolved) edges.push({from:file,to:path.relative(projectRoot,resolved).split(path.sep).join('/'),kind:'import',line:ln});
          else if(spec.startsWith('.')) diagnostics.push({file,line:ln,message:`Unresolved relative import ${spec}`});
        }
        if(ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isArrowFunction(node)||ts.isFunctionExpression(node)) {
          const parent=node.parent;
          const name=node.name?.getText(source)|| (ts.isVariableDeclaration(parent)?parent.name.getText(source):'<anonymous>');
          record.functions.push({name,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,endLine:source.getLineAndCharacterOfPosition(node.end).line+1});
        }
        if(ts.isCallExpression(node)) {
          const callee=node.expression.getText(source);
          if(callee.length<100) edges.push({from:file,to:file,kind:'call',callee,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
        }
        if(ts.isIdentifier(node)) record.identifiers++;
        if((ts.isJsxAttribute(node)||ts.isPropertyAssignment(node)) && /^on[A-Z]/.test(node.name?.getText(source)||'')) {
          events.push({file,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,event:node.name.getText(source),handler:node.initializer?.getText(source).slice(0,180)||''});
        }
        ts.forEachChild(node,walk);
      }
      walk(source);
    }
    modules.push(record);
  }
  const fileSet=new Set(modules.map(m=>m.file));
  const coverage={discovered:modules.length,parsed:modules.filter(m=>m.status==='parsed').length,skipped:skipped.length,parseErrors:diagnostics.length,dynamicallyTested:0};
  return {projectRoot,summary:{...coverage,imports:edges.filter(e=>e.kind==='import').length,functions:modules.reduce((n,m)=>n+m.functions.length,0),events:events.length,cssRules:styleRules.length},modules,edges:edges.filter(e=>e.kind!=='call'||fileSet.has(e.to)),events,styleRules,diagnostics,skipped,limits:{maxFiles:MAX_FILES,maxFileBytes:MAX_FILE}};
}
