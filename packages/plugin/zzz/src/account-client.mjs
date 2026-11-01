// The plugin owns vault access and account scope; the provider owns wire protocol.
const scopes=new WeakMap();
export function accountDeviceStore({vault,owner,providerId="mihoyo",accountKey}) {
  let accounts=scopes.get(vault);if(!accounts){accounts=new Map();scopes.set(vault,accounts);}
  const id=JSON.stringify([providerId,accountKey]);
  if(!accounts.has(id))accounts.set(id,{});
  const store={key:accounts.get(id),read:()=>vault.getUserCredential(owner,providerId,accountKey),write(expected,device){
    const latest=store.read();
    if(!latest || JSON.stringify(latest.device)!==JSON.stringify(expected.device))throw Object.assign(new Error("DEVICE_CHANGED"),{code:"DEVICE_CHANGED",publicMessage:"账号绑定或设备配置已变化，未覆盖新配置。"});
    vault.saveCredential(providerId,accountKey,latest.cookies,device);
  }};
  return store;
}
export function createAccountClient({provider,vault,owner,providerId="mihoyo",accountKey,signal}) {
  const deviceStore=accountDeviceStore({vault,owner,providerId,accountKey}),account=deviceStore.read();
  if(!account)throw Object.assign(new Error("DEVICE_CHANGED"),{code:"DEVICE_CHANGED",publicMessage:"账号绑定已变化，请重新查询。"});
  return provider.createClient(account.cookies,account.device,{deviceStore,signal});
}
export function installAccountClient(ctx) {
  let client;
  Object.defineProperty(ctx,"client",{configurable:true,enumerable:true,get(){
    if(client===undefined) {
      const role=ctx.activeRole;
      client=role && ctx.provider?.createClient?createAccountClient({provider:ctx.provider,vault:ctx.vault,owner:ctx.event.unifiedUserId,providerId:role.providerId,accountKey:role.accountKey}):ctx.provider?.createClient?ctx.provider.createClient({},{}):ctx.provider;
    }
    return client;
  }});
}
