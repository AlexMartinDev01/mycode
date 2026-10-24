import fs from 'node:fs/promises';
import zlib from 'node:zlib';
/** Minimal safe PNG decoder for Chromium 8-bit RGB/RGBA screenshots; no extra automation dependency. */
export function decodePng(bytes) {
  const data=Buffer.from(bytes);
  if(!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG signature');
  let pos=8,width,height,colorType,bitDepth,interlace,compressed=[];
  while(pos+12<=data.length){const size=data.readUInt32BE(pos),type=data.toString('ascii',pos+4,pos+8),body=data.subarray(pos+8,pos+8+size);pos+=size+12;
    if(type==='IHDR'){width=body.readUInt32BE(0);height=body.readUInt32BE(4);bitDepth=body[8];colorType=body[9];interlace=body[12];}
    if(type==='IDAT')compressed.push(body);
    if(type==='IEND')break;
  }
  if(!width||!height||width*height>20000000)throw new Error('PNG dimensions unsupported');
  if(bitDepth!==8||![2,6].includes(colorType)||interlace!==0)throw new Error('Only noninterlaced RGB/RGBA PNG supported');
  const stride=width*(colorType===2?3:4),bpp=colorType===2?3:4;
  const raw=zlib.inflateSync(Buffer.concat(compressed),{maxOutputLength:(stride+1)*height+1024});
  if(raw.length!==(stride+1)*height)throw new Error('PNG scanline size mismatch');
  const out=Buffer.alloc(width*height*4);let offset=0,prev=Buffer.alloc(stride),cur=Buffer.alloc(stride);
  for(let y=0;y<height;y++){
    const filter=raw[offset++];
    for(let x=0;x<stride;x++){
      const v=raw[offset++],a=x>=bpp?cur[x-bpp]:0,b=prev[x],c=x>=bpp?prev[x-bpp]:0;
      let p=0;if(filter===1)p=a;else if(filter===2)p=b;else if(filter===3)p=Math.floor((a+b)/2);else if(filter===4){const q=a+b-c,pa=Math.abs(q-a),pb=Math.abs(q-b),pc=Math.abs(q-c);p=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}else if(filter!==0)throw new Error('Unsupported PNG filter');
      cur[x]=(v+p)&255;
    }
    for(let x=0;x<width;x++){const at=(y*width+x)*4,from=x*bpp;out[at]=cur[from];out[at+1]=cur[from+1];out[at+2]=cur[from+2];out[at+3]=bpp===4?cur[from+3]:255;}
    [cur,prev]=[prev,cur];
  }
  return {width,height,data:out};
}
export function comparePng(a,b,{tolerance=18,maxChangedRatio=0.003}={}) {
  const x=decodePng(a),y=decodePng(b);
  if(x.width!==y.width||x.height!==y.height)return {pass:false,reason:'dimension-mismatch',actual:[x.width,x.height],baseline:[y.width,y.height]};
  let changed=0;for(let i=0;i<x.data.length;i+=4){if(Math.max(Math.abs(x.data[i]-y.data[i]),Math.abs(x.data[i+1]-y.data[i+1]),Math.abs(x.data[i+2]-y.data[i+2]))>tolerance)changed++;}
  const changedRatio=changed/(x.width*x.height);
  return {pass:changedRatio<=maxChangedRatio,changedPixels:changed,totalPixels:x.width*x.height,changedRatio,threshold:maxChangedRatio,tolerance};
}
export async function comparePngFiles(actual,baseline,opts){return comparePng(await fs.readFile(actual),await fs.readFile(baseline),opts);}
