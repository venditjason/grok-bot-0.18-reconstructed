import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const requiredRendererAssets=Object.freeze(['index.html','app.js','react.js','vds.js','vds.css','style.css']);
export function assertNonEmptyAsset(text,filename){
 if(typeof text!=='string'||!text.trim())throw new Error(`Required renderer asset is empty: ${filename}`);
 return text;
}
/** File Provider may advertise a full file while returning zero or partial bytes. */
export async function readRendererText(filename,io={readFile,stat}){
 const before=await io.stat(filename);
 if(!before.isFile()||!Number.isSafeInteger(before.size)||before.size<=0)throw new Error(`Required renderer asset is missing or empty: ${filename}`);
 const bytes=await io.readFile(filename),after=await io.stat(filename);
 if(!Buffer.isBuffer(bytes)||bytes.length!==before.size||after.size!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error(`Incomplete or changed renderer asset read: ${filename}`);
 return assertNonEmptyAsset(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),filename);
}

/** Snapshot actual bytes, not stat alone; compare again after package copying. */
export async function validateRendererAssets(directory,expected,io){
 const result={};
 for(const name of requiredRendererAssets){
  const text=await readRendererText(path.join(directory,name),io);
  const sha256=createHash('sha256').update(text).digest('hex');
  result[name]={bytes:Buffer.byteLength(text,'utf8'),sha256};
  if(expected&&(expected[name]?.bytes!==result[name].bytes||expected[name]?.sha256!==sha256))throw new Error(`Renderer asset changed during packaging: ${name}`);
 }
 return result;
}

/** Use the checked read as esbuild's actual renderer input, avoiding a second unchecked read. */
export function rendererInputPlugin(directory,io){
 const prefix=path.resolve(directory)+path.sep;
 return {name:'venditbot-renderer-inputs',setup(build){
  build.onLoad({filter:/\.[cm]?[jt]sx?$/,namespace:'file'},async args=>{
   if(!path.resolve(args.path).startsWith(prefix))return;
   const extension=path.extname(args.path).slice(1),loader=extension==='tsx'?'tsx':extension==='jsx'?'jsx':['ts','mts','cts'].includes(extension)?'ts':'js';
   return {contents:await readRendererText(args.path,io),loader,resolveDir:path.dirname(args.path)};
  });
 }};
}
