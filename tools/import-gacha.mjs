import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {IdentityVault} from "../packages/core/src/identity/vault.mjs";
import {ZzzStore} from "../packages/plugin/zzz/src/storage.mjs";
import {importGacha} from "../packages/plugin/zzz/src/gacha.mjs";

/** Auxiliary import into the same owner-scoped store used by automatic sync. */
export function importGachaJson(filename,vaultOrPath,{owner,uid}={}) {
  if(!owner || !uid)throw new Error("导入必须显式指定聊天用户标识和 UID。");
  if(fs.statSync(filename).size>5000000)throw new Error("导入文件超过 5 MB。");
  const own=typeof vaultOrPath==="string";
  const vault=own?new IdentityVault(vaultOrPath):vaultOrPath;
  try {
    const role=vault.getUserRoles(owner,"zzz").find(row=>row.uid===String(uid));
    if(!role)throw new Error("该 UID 没有绑定到指定聊天用户，拒绝猜测账号归属。");
    const rows=importGacha(fs.readFileSync(filename,"utf8"),role);
    const store=new ZzzStore(vault);
    const added=store.importGacha(owner,role,rows);
    return {total:rows.length,added,sRanks:rows.filter(row=>row.rank_type==="4").length,aRanks:rows.filter(row=>row.rank_type==="3").length,uid:role.uid};
  } finally {if(own)vault.close();}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const [filename,owner,uid,dbPath="data/vault.db"]=process.argv.slice(2);
  try {
    if(!filename || !owner || !uid)throw new Error("用法：node tools/import-gacha.mjs <JSON文件> <统一聊天用户ID> <UID> [数据库]");
    console.log(JSON.stringify(importGachaJson(filename,dbPath,{owner,uid})));
  } catch(error) {console.error("导入失败："+error.message);process.exitCode=1;}
}
