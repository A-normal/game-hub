/** Reproducible, pinned MIT source import. Run explicitly; no postinstall or runtime download. */
import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
const root=fileURLToPath(new URL("..",import.meta.url));
const pin="2ce06b88a442531b49d84cbed15204a4a03d078a";
const repository="frzyc/genshin-optimizer";
const directory=path.join(root,"packages/plugin/zzz/vendor/optimizer");
const base="https://raw.githubusercontent.com/"+repository+"/"+pin+"/";
const cache=new Map(),manifest={repository,pin,license:"MIT",files:{}};
async function source(filename) {
  if(cache.has(filename))return cache.get(filename);
  const promise=(async()=>{
    const destination=path.join(directory,"source",filename);
    let text;try {text=await fs.readFile(destination,"utf8");}catch {
      let response;for(let attempt=0;attempt<3;attempt++){try {response=await fetch(base+filename,{signal:AbortSignal.timeout(20000),redirect:"error"});if(response.ok)break;if(response.status===404)return null;}catch(error){if(attempt===2)throw error;}}
      if(!response?.ok)throw new Error("Cannot fetch "+filename);
      text=await response.text();await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,text);
    }
    manifest.files[filename]=createHash("sha256").update(text).digest("hex");return text;
  })();cache.set(filename,promise);return promise;
}
const config=JSON.parse(await source("tsconfig.base.json"));
const aliases=config.compilerOptions.paths;
await source("LICENSE");
const plugin={name:"pinned-mit-source",setup(builder){
  builder.onResolve({filter:/.*/},async args=>{
    if(args.kind==="entry-point")return;
    let filename;
    if(args.path.startsWith("@genshin-optimizer/"))filename=aliases[args.path]?.[0]?.replace(/^\.\//,"");
    else if(args.path.startsWith("."))filename=path.posix.normalize(path.posix.join(path.posix.dirname(args.importer),args.path));
    else return {path:args.path,external:true,sideEffects:false};
    if(!filename || !/^libs\/(zzz|pando|game-opt|common)\//.test(filename))throw new Error("Unexpected source import "+args.path);
    const candidates=/\.(ts|tsx|js|json)$/.test(filename)?[filename]:[filename+".ts",filename+".tsx",filename+".json",filename+"/index.ts"];
    for(const candidate of candidates) {
      try {await fs.access(path.join(directory,"source",candidate));return {path:candidate,namespace:"optimizer-source"};}catch {}
    }
    for(const candidate of candidates) {
      if(await source(candidate)!==null)return {path:candidate,namespace:"optimizer-source"};
    }
    throw new Error("Cannot resolve "+filename);
  });
  builder.onLoad({filter:/.*/,namespace:"optimizer-source"},async args=>({contents:await source(args.path),loader:args.path.endsWith(".json")?"json":args.path.endsWith(".tsx")?"tsx":"ts"}));
}};
// Use public package aliases, but expose only pure calculation/data contracts.
let entry="export {Calculator,zzzCalculatorWithValues,zzzCalculatorWithEntries,own,ownBuff,enemy,reader,userBuff,formulaCatalog,charTagMapNodeEntries,wengineTagMapNodeEntries,discTagMapNodeEntries,discsToTagMapNodeEntries,teamData,withMember,withPreset,convert,getStatFromStatKey} from '@genshin-optimizer/zzz/formula';\nexport {allStats,mappedStats} from '@genshin-optimizer/zzz/stats';\nexport {allCharacterKeys,allWengineKeys,allDiscSetKeys,getDiscMainStatVal,getDiscSubStatBaseVal} from '@genshin-optimizer/zzz/consts';\n";
entry+="export {getConditional,conditionals} from '@genshin-optimizer/zzz/formula';\n";
for(const [name,filename] of Object.entries({characterIds:"libs/zzz/dm/src/dm/character/characterIdMap.json",weaponIds:"libs/zzz/dm/src/dm/wengine/wengineIdMap.json",discIds:"libs/zzz/dm/src/dm/disc/discIdMap.json"}))entry+="export const "+name+" = "+await source(filename)+";\n";
const result=await build({stdin:{contents:entry,sourcefile:"entry.ts",resolveDir:root},bundle:true,write:false,platform:"node",format:"esm",target:"node22",treeShaking:true,minify:false,plugins:[plugin],metafile:true,define:{"import.meta.env.DEV":"false","import.meta.env.PROD":"true","process.env.NODE_ENV":'"production"'},banner:{js:"// Vendored from "+repository+" @ "+pin+". MIT; see source/LICENSE and manifest.json.\n"}});
const external=result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].imports.filter(item=>item.external && !item.path.startsWith("node:"));
if(external.length)throw new Error("Unexpected runtime dependencies: "+JSON.stringify(external));
await fs.writeFile(path.join(directory,"engine.mjs"),result.outputFiles[0].text);
manifest.bundleSha256=createHash("sha256").update(result.outputFiles[0].text).digest("hex");
manifest.buildTool="esbuild@0.28.2";
manifest.files=Object.fromEntries(Object.entries(manifest.files).sort(([a],[b])=>a.localeCompare(b)));
await fs.writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
await fs.copyFile(path.join(directory,"source/LICENSE"),path.join(directory,"LICENSE"));
console.log(JSON.stringify({files:Object.keys(manifest.files).length,bytes:result.outputFiles[0].contents.length,pin}));
