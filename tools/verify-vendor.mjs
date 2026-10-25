import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
export async function verifyVendor() {
  const root=fileURLToPath(new URL("../packages/plugin/zzz/vendor/optimizer/",import.meta.url));
  const manifest=JSON.parse(await fs.readFile(path.join(root,"manifest.json"),"utf8"));
  const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
  for(const [filename,expected] of Object.entries(manifest.files)) {
    const target=path.resolve(root,"source",filename),scope=path.join(root,"source")+path.sep;
    if(!target.startsWith(scope))throw new Error("Unsafe vendor source path");
    if(hash(await fs.readFile(target))!==expected)throw new Error("Vendor source differs: "+filename);
  }
  if(hash(await fs.readFile(path.join(root,"engine.mjs")))!==manifest.bundleSha256)throw new Error("Vendor bundle differs");
  if(!Buffer.from(await fs.readFile(path.join(root,"LICENSE"))).equals(await fs.readFile(path.join(root,"source/LICENSE"))))throw new Error("Vendor license differs");
  return {pin:manifest.pin,files:Object.keys(manifest.files).length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await verifyVendor()));
