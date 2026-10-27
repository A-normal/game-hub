import {clipText,isSensitiveText} from "./session.mjs";
// Finite actions only. Models cannot supply file paths, URLs, targets or RPC names.
export function parseReplyPlan(raw,{assets=[],maxChars=600,allowSilence=false}={}) {
  const source=String(raw || "").trim();let text=source,sticker=null;
  if(isSensitiveText(source.replace(/\[CQ:[^\]]*\]?/gi,"")))return [];
  if(allowSilence && source==="[不回复]")return [];
  if(source.startsWith("{")) {
    try {
      const value=JSON.parse(source);
      if(!Array.isArray(value.actions) || value.actions.length>3)return [];
      text=value.actions.filter(a=>a?.type==="text" && typeof a.text==="string").map(a=>a.text).join("\n");
      sticker=value.actions.find(a=>a?.type==="sticker")?.id;
    }catch{return [];}
  } else {
    sticker=/\[sticker:([a-z0-9_-]{1,40})\]/i.exec(source)?.[1];
    text=source.replace(/\[sticker:[^\]]*\]/gi,"");
  }
  text=clipText(text,maxChars);
  if(isSensitiveText(text))return [];
  const plan=[];
  if(text)plan.push({type:"text",text});
  if(sticker && assets.some(s=>s.id===sticker))plan.push({type:"sticker",id:sticker});
  return plan;
}
