import { buildDeviceExtFields } from "../vendor/android-device/payload.mjs";

export const ANDROID_APP_VERSION="2.104.0";
const fields={deviceName:128,deviceBoard:128,deviceModel:128,oaid:128,androidVersion:32,deviceFingerprint:512,deviceProduct:128};
export function normalizeAndroidProfile(value) {
  if(!value || typeof value!=="object" || Array.isArray(value))throw new TypeError("Android 设备信息应为 JSON 对象。");
  const result={};
  for(const [key,max] of Object.entries(fields)) {
    if(typeof value[key]!=="string" || !value[key].trim() || value[key].length>max || !/^[\x20-\x7e]+$/.test(value[key]))throw new TypeError("Android 设备字段缺失或格式错误："+key);
    result[key]=value[key].trim();
  }
  if(!/^\d{1,2}(?:\.\d{1,2}){0,2}$/.test(result.androidVersion))throw new TypeError("Android 版本格式错误。");
  return result;
}
export function androidExtFields(value) {
  const info=normalizeAndroidProfile(value),brand=info.deviceFingerprint.split("/")[0];
  // Unknown ancillary fields remain documented template defaults, never reported as observed hardware.
  const ext=JSON.parse(buildDeviceExtFields({deviceName:info.deviceName,product:info.deviceProduct},ANDROID_APP_VERSION));
  Object.assign(ext,{deviceName:info.deviceName,productName:info.deviceProduct,model:info.deviceModel,brand,manufacturer:brand,deviceType:info.deviceName,deviceInfo:info.deviceFingerprint,oaid:info.oaid,osVersion:info.androidVersion,board:info.deviceBoard});
  const build=info.deviceFingerprint.split(":")[2];if(build){ext.buildType=build.split("/")[0];ext.buildTags=build.split("/").at(-1);}
  return ext;
}
export function androidHeaders(value) {
  const info=normalizeAndroidProfile(value),brand=info.deviceFingerprint.split("/")[0];
  return {"x-rpc-device_name":brand+" "+info.deviceModel,"x-rpc-device_model":info.deviceModel,"x-rpc-sys_version":info.androidVersion,"x-rpc-app_version":ANDROID_APP_VERSION,"x-rpc-client_type":"2","x-rpc-channel":"mihoyo","User-Agent":"Mozilla/5.0 (Linux; Android "+info.androidVersion+"; "+info.deviceModel+"; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.5563.116 Mobile Safari/537.36 miHoYoBBS/"+ANDROID_APP_VERSION};
}
