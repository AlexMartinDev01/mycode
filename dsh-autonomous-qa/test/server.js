import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
export async function serve(root,port=0) {
 const base=path.resolve(root);
 const server=http.createServer(async (req,res)=>{
   try {
     const p=path.resolve(base,'.'+new URL(req.url,'http://localhost').pathname);
     if(p!==base&&!p.startsWith(base+path.sep)){res.writeHead(403).end('Forbidden');return;}
     const buf=await fs.readFile(p);
     const ext=path.extname(p);res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json'})[ext]||'application/octet-stream');res.end(buf);
   }catch(e){res.writeHead(404).end('Not found');}
 });
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 return {server,url:`http://127.0.0.1:${server.address().port}`,stop:()=>new Promise(r=>server.close(r))};
}
