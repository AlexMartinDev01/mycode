import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';

const timeoutError = label => new Error(`CDP timeout: ${label}`);
function validateLocalUrl(url, allowExternal=false) {
  const parsed=new URL(url);
  if(!['http:','https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs supported');
  if(!allowExternal && !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new Error('Refusing external URL. Explicit allowExternal=true required');
  return parsed.toString();
}
async function freePort() {return await new Promise((resolve,reject)=>{const srv=net.createServer();srv.on('error',reject);srv.listen(0,'127.0.0.1',()=>{let p=srv.address().port;srv.close(()=>resolve(p));});});}

export class CdpConnection extends EventEmitter {
  constructor(socket) {super();this.socket=socket;this.nextId=1;this.pending=new Map();this.closed=false;
    socket.addEventListener('message',ev=>{
      let packet;try {packet=JSON.parse(typeof ev.data==='string'?ev.data:ev.data.toString());}catch{return;}
      if(typeof packet.id==='number') {
        const p=this.pending.get(packet.id);if(!p)return;
        clearTimeout(p.timer);this.pending.delete(packet.id);
        if(packet.error)p.reject(new Error(`${p.method}: ${packet.error.message}`));else p.resolve(packet.result||{});
      } else if(packet.method) this.emit(packet.method,packet.params||{});
    });
    const close=()=>{this.closed=true;for(const [id,p] of this.pending){clearTimeout(p.timer);p.reject(new Error('CDP socket closed'));}this.pending.clear();this.emit('closed');};
    socket.addEventListener('close',close);
    socket.addEventListener('error',err=>this.emit('socket-error',err));
  }
  static async connect(url, timeout=8000) {
    return await new Promise((resolve,reject)=>{
      const ws=new WebSocket(url);
      const timer=setTimeout(()=>{ws.close();reject(timeoutError('WebSocket connect'));},timeout);
      ws.addEventListener('open',()=>{clearTimeout(timer);resolve(new CdpConnection(ws));},{once:true});
      ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP websocket connect failed'));},{once:true});
    });
  }
  command(method,params={},timeout=12000) {
    if(this.closed||this.socket.readyState!==WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(timeoutError(method));},timeout);
      this.pending.set(id,{resolve,reject,timer,method});
      try{this.socket.send(JSON.stringify({id,method,params}));}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  close(){if(!this.closed)this.socket.close();}
}

export class ChromiumDriver {
  constructor(options={}) {this.options=options;this.logs={exceptions:[],console:[],network:[]};this.cssHeaders=new Map();this.requestInfo=new Map();this.ready=false;this.child=null;this.cdp=null;}
  async start() {
    const port=await freePort();this.port=port;
    this.tempDir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-qa-'));
    const executable=this.options.executablePath||process.env.CHROMIUM_PATH||'/usr/bin/chromium';
    const args=[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${this.tempDir}`,'--no-first-run','--no-default-browser-check','--headless=new','--disable-gpu','--disable-dev-shm-usage','about:blank'];
    if(process.getuid?.()===0)args.unshift('--no-sandbox');
    this.child=spawn(executable,args,{stdio:'ignore',env:{...process.env}});
    this.child.on('error',err=>{this.launchError=err;});
    let list;
    try {
      for(let i=0;i<65;i++) {
        if(this.launchError)throw this.launchError;
        if(this.child.exitCode!==null)throw new Error(`Chromium exited: ${this.child.exitCode}`);
        try {const resp=await fetch(`http://127.0.0.1:${port}/json/list`);if(resp.ok){list=await resp.json();if(list.find(t=>t.type==='page'&&t.webSocketDebuggerUrl))break;}}catch{}
        await delay(100);
      }
      const page=list?.find(t=>t.type==='page'&&t.webSocketDebuggerUrl);
      if(!page) throw new Error('Chromium CDP page not ready');
      this.cdp=await CdpConnection.connect(page.webSocketDebuggerUrl);
      this.cdp.on('Runtime.exceptionThrown',e=>this.logs.exceptions.push({text:e.exceptionDetails?.text,line:e.exceptionDetails?.lineNumber,url:e.exceptionDetails?.url,stack:e.exceptionDetails?.stackTrace?.callFrames}));
      this.cdp.on('Runtime.consoleAPICalled',e=>{if(['error','warning','assert'].includes(e.type))this.logs.console.push({type:e.type,args:e.args?.map(x=>x.value??x.description)});});
      this.cdp.on('Network.requestWillBeSent',e=>{this.requestInfo.set(e.requestId,{url:e.request?.url,method:e.request?.method});if(this.requestInfo.size>1000)this.requestInfo.delete(this.requestInfo.keys().next().value);});
      this.cdp.on('Network.responseReceived',e=>{const req=this.requestInfo.get(e.requestId)||{};this.logs.network.push({url:e.response?.url,status:e.response?.status,httpMethod:req.method||null,method:'RESPONSE'});if(this.logs.network.length>1000)this.logs.network.shift();});
      this.cdp.on('Network.loadingFailed',e=>{this.logs.network.push({url:e.requestId,error:e.errorText,method:'FAILED'});});
      this.cdp.on('CSS.styleSheetAdded',e=>{this.cssHeaders.set(e.header.styleSheetId,e.header);});
      await Promise.all(['Page.enable','Runtime.enable','Network.enable','DOM.enable','CSS.enable'].map(x=>this.cdp.command(x)));
      await this.setViewport(this.options.width||1280,this.options.height||800);
      this.ready=true;return this;
    }catch(e){await this.stop();throw e;}
  }
  async setViewport(width=1280,height=800) {
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<200||height<200||width>4096||height>4096)throw new Error('Invalid viewport size');
    await this.cdp.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<=600});
    this.viewport={width,height};return this.viewport;
  }
  async navigate(url,{allowExternal=this.options.allowExternal||false}={}) {
    url=validateLocalUrl(url,allowExternal);
    const r=await this.cdp.command('Page.navigate',{url});
    if(r.errorText)throw new Error(`Navigation failed: ${r.errorText}`);
    await this.waitFor('document.readyState === "complete"',12000);
    return {url:await this.evaluate('location.href')};
  }
  async evaluate(expression,timeout=8000) {
    const result=await this.cdp.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,generatePreview:false},timeout);
    if(result.exceptionDetails)throw new Error(`Browser evaluation error: ${result.exceptionDetails.text||result.exceptionDetails.exception?.description}`);
    if(result.result?.type==='undefined')return null;
    return result.result?.value??null;
  }
  async waitFor(expr,timeoutMs=6000) {
    const start=Date.now();
    while(Date.now()-start<timeoutMs){if(await this.evaluate(`Boolean(${expr})`))return true;await delay(90);}
    throw timeoutError(`waitFor ${expr.slice(0,80)}`);
  }
  async inspect(selector) {
    return await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,text:(e.innerText||e.value||'').slice(0,500),outerHTML:e.outerHTML.slice(0,500),rect:{x:r.x,y:r.y,width:r.width,height:r.height},value:e.value??null,styles:{color:s.color,background:s.backgroundColor,display:s.display,visibility:s.visibility,position:s.position,zIndex:s.zIndex,fontSize:s.fontSize,overflow:s.overflow},visible:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};})()`);
  }
  async click(selector){
    const pos=await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,width:r.width,height:r.height,obstructed:!hit||!(hit===e||e.contains(hit)),hit:hit?.outerHTML.slice(0,180)||null};})()`);
    if(!pos)throw new Error(`Element not found: ${selector}`);
    if(pos.width===0||pos.height===0)throw new Error(`Element is hidden: ${selector}`);
    if(pos.obstructed)throw new Error(`Element center obstructed: ${selector} by ${pos.hit}`);
    await this.cdp.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:pos.x,y:pos.y});
    await this.cdp.command('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1});
    await this.cdp.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1});
    return {clicked:true,point:{x:pos.x,y:pos.y}};
  }
  async fill(selector,value){
    const node=await this.inspect(selector);if(!node)throw new Error(`Element not found: ${selector}`);
    await this.click(selector);
    await this.cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await this.cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await this.cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await this.cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await this.cdp.command('Input.insertText',{text:String(value)});
    return {filled:true,value:await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value??null`)};
  }
  async screenshot(outputPath){
    const {data}=await this.cdp.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    if(outputPath){await fs.mkdir(path.dirname(path.resolve(outputPath)),{recursive:true});await fs.writeFile(outputPath,Buffer.from(data,'base64'));return {path:path.resolve(outputPath),bytes:Buffer.byteLength(data,'base64')};}
    return {base64:data};
  }
  async cssFor(selector){
    const {root}=await this.cdp.command('DOM.getDocument',{depth:1});
    const {nodeId}=await this.cdp.command('DOM.querySelector',{nodeId:root.nodeId,selector});
    if(!nodeId) return {selector,matched:false,rules:[]};
    const style=await this.cdp.command('CSS.getMatchedStylesForNode',{nodeId});
    const rules=[];
    for(const match of style.matchedCSSRules||[]) {
      const r=match.rule,h=this.cssHeaders.get(r.styleSheetId);
      rules.push({selector:r.selectorList?.text||'',origin:r.origin,url:h?.sourceURL||null,line:r.style?.range?.startLine!=null?r.style.range.startLine+1:null,selectorLine:r.selectorList?.selectors?.[0]?.range?.startLine!=null?r.selectorList.selectors[0].range.startLine+1:null,declarations:r.style?.cssProperties?.filter(p=>!p.disabled).map(p=>({name:p.name,value:p.value}))||[]});
    }
    return {selector,matched:true,rules};
  }
  async stop(){
    this.ready=false;try{this.cdp?.close();}catch{}
    if(this.child && this.child.exitCode===null){this.child.kill('SIGTERM');await Promise.race([new Promise(r=>this.child.once('exit',r)),delay(1200)]);if(this.child.exitCode===null)this.child.kill('SIGKILL');}
    if(this.tempDir)await fs.rm(this.tempDir,{recursive:true,force:true}).catch(()=>{});
    this.child=null;this.cdp=null;
  }
}
export { validateLocalUrl };
