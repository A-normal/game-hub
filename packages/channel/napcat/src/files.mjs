// File transport belongs to the channel. Plugins never receive bridge-local paths.
import {logger} from "@game-hub/core";
const failure=(code,message)=>Object.assign(new Error(message),{code,publicMessage:message});
export function decodeBase64(value,maxBytes) {
  if(typeof value!=="string" || value.length>Math.ceil(maxBytes/3)*4+4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw failure("FILE_INVALID","文件数据无效或超过大小上限。");
  const bytes=Buffer.from(value,"base64");
  if(bytes.length>maxBytes)throw failure("FILE_TOO_LARGE","文件超过大小上限。");
  return bytes;
}
export async function readAttachment(rpc,ws,attachment,{maxBytes=1024*1024}={}) {
  if(!Number.isInteger(maxBytes) || maxBytes<1 || maxBytes>4*1024*1024)throw failure("FILE_LIMIT","文件读取上限无效。");
  if(attachment.size>maxBytes)throw failure("FILE_TOO_LARGE","文件超过大小上限。");
  const id=String(attachment.id || "");
  if(!id || id.length>512 || /(?:^[a-z][a-z0-9+.-]*:|\\|\.\.)/i.test(id))throw failure("FILE_INVALID","渠道未提供可下载的文件 ID。");
  try {return await rpc.downloadFile(ws,id,maxBytes,30000,attachment.type==="image"?"download_file_image_stream":"download_file_stream");}
  catch(error) {
    if(error.code!=="ONEBOT_API_FAILED")throw error;
    // Older bridges may return base64; never read a path on the host or fetch arbitrary URLs.
    const result=await rpc.callApi(ws,attachment.type==="image"?"get_image":"get_file",{file_id:id});
    if(result.data?.base64)return decodeBase64(result.data.base64.replace(/^base64:\/\//,""),maxBytes);
    throw failure("FILE_UNAVAILABLE","当前 NapCat 无法跨容器读取文件，请升级到支持 Stream API 的版本（4.8.115+）。");
  }
}
export async function deliver(rpc,ws,target,content,options={}) {
  const started=Date.now();
  const files=content?.files || [],segments=content?.segments;
  if(files.length>5)throw failure("DELIVERY_UNSUPPORTED","一次最多发送五个文件。");
  const messages=segments ? [segments.map(s=>{
    if(s.type==="text")return {type:"text",data:{text:String(s.text || "")}};
    if(s.type==="image" && /^(https:\/\/|base64:\/\/)/.test(s.file || ""))return {type:"image",data:{file:s.file}};
    throw failure("DELIVERY_UNSUPPORTED","不支持此消息段。");
  })] : [];
  const text=typeof content==="string"?content:String(content?.text ?? content?.content ?? "");
  if(text)for(let i=0,chars=Array.from(text);i<chars.length;i+=2500)messages.push(chars.slice(i,i+2500).join(""));
  const prepared=files.map(file=>{
    if(!/^[^\\/\x00-\x1f]{1,120}$/.test(file.name || ""))throw failure("FILE_INVALID","导出文件名无效。");
    const bytes=Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data || "");
    if(bytes.length>4*1024*1024)throw failure("FILE_TOO_LARGE","导出文件超过4 MiB。");
    return {name:file.name,file:"base64://"+bytes.toString("base64")};
  });
  const delivered=[];
  try {
    for(const [index,part] of messages.entries()) {
      let message=part;
      if(index===0 && options.quote && target.messageId)message=[{type:"reply",data:{id:String(target.messageId)}},...(typeof part==="string"?[{type:"text",data:{text:part}}]:part)];
      const params={message_type:target.isGroup?"group":"private",...(target.isGroup?{group_id:target.groupId}:{user_id:target.userId}),message};
      const result=await rpc.callApi(ws,"send_msg",params);delivered.push(String(result.data?.message_id || ""));
    }
    for(const file of prepared) {
      await rpc.callApi(ws,target.isGroup?"upload_group_file":"upload_private_file",{...(target.isGroup?{group_id:target.groupId}:{user_id:target.userId}),...file},30000);
      delivered.push("");
    }
    logger.info("Gateway:Egress",`渠道交付成功 parts=${delivered.length} elapsedMs=${Date.now()-started}`);
    return {success:true,messageId:delivered.find(Boolean) || "",messageIds:delivered.filter(Boolean),partsDelivered:delivered.length};
  } catch(error) {
    logger.warn("Gateway:Egress",`渠道交付失败 code=${error.code || 'DELIVERY_FAILED'} retcode=${Number.isFinite(error.retcode)?error.retcode:'-'} parts=${delivered.length} elapsedMs=${Date.now()-started}`);
    return {success:false,partial:delivered.length>0,partsDelivered:delivered.length,messageIds:delivered.filter(Boolean),error:"渠道发送失败，已发送部分不会自动重试。"};
  }
}
