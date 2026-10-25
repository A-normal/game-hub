import { problem } from "./text.mjs";
export const POOLS = Object.freeze({ "1001":"常驻频段", "2001":"独家频段", "3001":"音擎频段", "5001":"邦布频段", "12001":"独家重映", "13001":"音擎回响" });
const poolAliases={"1":"1001","2":"2001","3":"3001","5":"5001"};
const hosts = new Set(["public-operation-nap.mihoyo.com","public-operation-nap-sg.hoyoverse.com","public-operation-common.mihoyo.com","public-operation-common-sg.hoyoverse.com"]);
export function parseGachaLink(input, role) {
  let url; try { url = new URL(input); } catch { throw problem("请输入完整的官方调频记录链接。"); }
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port && url.port !== "443" || url.pathname !== "/common/gacha_record/api/getGachaLog") throw problem("仅接受官方调频记录 API 链接。");
  const uid = url.searchParams.get("uid");
  if (uid && uid !== String(role.uid)) throw problem("链接 UID 与当前角色不一致。");
  if ((role.region === "prod_gf_cn") !== url.hostname.endsWith(".mihoyo.com")) throw problem("链接区服与当前角色不一致。");
  const authkey = url.searchParams.get("authkey");
  if (!authkey || authkey.length > 20000) throw problem("链接缺少有效的 authkey。");
  return authkey;
}
export function normalizeGacha(record, role, pool) {
  if (!record || typeof record.id !== "string" || !/^\d{1,40}$/.test(record.id)) throw problem("记录 ID 必须为十进制字符串，拒绝可能丢失精度的数据。");
  if (String(record.uid) !== String(role.uid)) throw problem("调频记录所属 UID 与当前角色不一致，未写入任何记录。");
  if (record.region && record.region !== role.region) throw problem("调频记录区服不一致。");
  const rawType = String(record.gacha_type ?? record.uigf_gacha_type ?? pool ?? "");
  const type = poolAliases[rawType] || rawType;
  if (!POOLS[type] || pool && type !== String(pool)) throw problem("调频记录卡池类型不一致。");
  if (!/^[234]$/.test(String(record.rank_type))) throw problem("调频记录稀有度无效（ZZZ S/A/B 对应 4/3/2）。");
  if (typeof record.time !== "string" || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(record.time) || !Number.isFinite(Date.parse(record.time.replace(" ","T")+"Z"))) throw problem("调频记录时间无效。");
  if(new Date(record.time.replace(" ","T")+"Z").toISOString().slice(0,19)!==record.time.replace(" ","T"))throw problem("调频记录时间不是有效的日历时间。");
  if(record.count!==undefined && String(record.count)!=="1")throw problem("单条调频记录的数量必须为 1。");
  if (typeof record.name !== "string" || !record.name.trim() || record.name.length > 200) throw problem("调频记录名称无效。");
  return { id:record.id,uid:String(role.uid),region:role.region,gacha_type:type,item_id:String(record.item_id || ""),item_type:String(record.item_type || ""),name:record.name,rank_type:String(record.rank_type),count:String(record.count || "1"),time:record.time.replace("T"," ") };
}
export async function syncGacha({ client, role, owner, store, authkey, maxPages = 1000 }) {
  const staged = new Map();
  for (const type of Object.keys(POOLS)) {
    let cursor = "0"; const cursors = new Set(); let finished = false;
    for (let page = 0; page < maxPages; page++) {
      const data = await client.gachaPage(role.uid,role.region,type,cursor,authkey,page+1);
      if (!Array.isArray(data.list)) throw problem("调频接口没有返回记录列表，未写入任何记录。");
      if (!data.list.length) { finished = true; break; }
      for (const raw of data.list) {
        const row = normalizeGacha(raw,role,type);
        const previous = staged.get(row.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw problem("调频接口返回了冲突的记录 ID。");
        staged.set(row.id,row);
      }
      const next = data.list.at(-1).id;
      if (next === cursor || cursors.has(next) || cursor !== "0" && BigInt(next) >= BigInt(cursor)) throw problem("调频分页游标异常，未写入任何记录。");
      cursors.add(next); cursor = next;
    }
    if (!finished) throw problem("调频分页超过上限，未写入任何记录。");
  }
  const added = store.importGacha(owner,role,[...staged.values()]);
  return { added, fetched:staged.size };
}
export function importGacha(input, role) {
  let data; try { data = JSON.parse(input); } catch { throw problem("导入内容不是有效 JSON。"); }
  let list;
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.nap)) {
    const account = data.nap.find(row => String(row.uid) === String(role.uid));
    if (!account) throw problem("UIGF 文件没有当前 UID。");
    list = account.list?.map(row => ({ ...row,uid:account.uid }));
  } else if (data.info && Array.isArray(data.list) && String(data.info.uid) === String(role.uid)) list = data.list.map(row => ({ ...row,uid:data.info.uid }));
  if (!Array.isArray(list) || list.length > 50000) throw problem("仅支持 ZZZ UIGF 的 nap 账号列表、SRGF 结构或带 UID 的记录数组。");
  return list.map(row => normalizeGacha(row,role));
}
export function gachaStatistics(records) {
  return Object.entries(POOLS).map(([type,name]) => {
    const rows = records.filter(row => row.gacha_type === type);
    let pity = 0; const wins = [];
    for (const row of rows) { pity++; if (row.rank_type === "4") { wins.push({name:row.name,pulls:pity,time:row.time}); pity=0; } }
    return {type,name,total:rows.length,s:wins.length,a:rows.filter(row=>row.rank_type==="3").length,pity,average:wins.length ? wins.reduce((n,w)=>n+w.pulls,0)/wins.length : null,wins};
  });
}
