import {createHash} from "node:crypto";
import {problem} from "./text.mjs";
export const HISTORY_SOURCE="https://raw.githubusercontent.com/iaoongin/GachaClock/main/spider/data/zzz/history.json";
export const PUBLIC_ROLE={uid:"0",region:"public"};
export async function fetchPublicJson(url,{fetchImpl=(...args)=>fetch(...args),maxBytes=2000000}={}) {
  const response=await fetchImpl(url,{headers:{"User-Agent":"Game-Hub/1.0",Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw problem("公共数据源暂时不可用（HTTP "+response.status+"）。");
  if(Number(response.headers?.get?.("content-length"))>maxBytes) throw problem("公共数据源响应超过大小限制。");
  let text;
  if(response.body?.getReader) {
    const reader=response.body.getReader(),chunks=[];let count=0;
    try {while(true) {const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maxBytes)throw problem("公共数据源响应超过大小限制。");chunks.push(Buffer.from(value));}}
    finally {await reader.cancel().catch(()=>{});}
    text=Buffer.concat(chunks).toString("utf8");
  } else text=response.text?await response.text():JSON.stringify(await response.json());
  if(Buffer.byteLength(text)>maxBytes) throw problem("公共数据源响应超过大小限制。");
  let data;try {data=JSON.parse(text);}catch {throw problem("公共数据源格式异常。");}
  return {data,hash:createHash("sha256").update(text).digest("hex"),etag:response.headers?.get?.("etag") || null};
}
export async function refreshPoolHistory(store,services={}) {
  const {data,hash,etag}=await fetchPublicJson(HISTORY_SOURCE,{fetchImpl:services.fetchImpl});
  if(!Array.isArray(data) || !data.length || data.length>3000) throw problem("卡池历史数据格式异常，旧缓存已保留。");
  const rows=data.map(row=>{
    if(!row.title || !row.version || !row.timer || !row.s || !["角色","武器"].includes(row.type) || !Array.isArray(row.a)) throw problem("卡池历史缺少必要字段，旧缓存已保留。");
    return {title:String(row.title).slice(0,200),version:String(row.version).slice(0,40),time:String(row.timer).slice(0,100),type:row.type,s:[...new Set(String(row.s).split(/[、,，]/).filter(Boolean))],a:row.a.map(String)};
  });
  const snapshot={rows,source:HISTORY_SOURCE,license:"MIT",hash,etag};
  store.put("public",PUBLIC_ROLE,"public","poolHistory",snapshot);return snapshot;
}
