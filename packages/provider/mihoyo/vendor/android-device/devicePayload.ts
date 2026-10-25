import type { DeviceFpRequest, DeviceInfo } from './types';
import { APP_VERSION } from './config';

function buildDeviceExtFields(profile: DeviceInfo): string {
  const extFields = {
    proxyStatus: 0,
    isRoot: 0,
    romCapacity: '512',
    deviceName: profile.deviceName,
    productName: profile.product,
    romRemain: '512',
    hostname: 'dg02-pool03-kvm87',
    screenSize: '1440x2905',
    isTablet: 0,
    aaid: '',
    model: profile.deviceName,
    brand: 'XiaoMi',
    hardware: 'qcom',
    deviceType: 'OP5913L1',
    devId: 'unknown',
    serialNumber: 'unknown',
    sdCardCapacity: 512215,
    buildTime: '1693626947000',
    buildUser: 'android-build',
    simState: '5',
    ramRemain: '239814',
    appUpdateTimeDiff: 1702604034882,
    deviceInfo: `XiaoMi ${profile.deviceName} OP5913L1:13 SKQ1.221119.001 T.118e6c7-5aa23-73911:user release-keys`,
    vaid: '',
    buildType: 'user',
    sdkVersion: '34',
    ui_mode: 'UI_MODE_TYPE_NORMAL',
    isMockLocation: 0,
    cpuType: 'arm64-v8a',
    isAirMode: 0,
    ringMode: 2,
    chargeStatus: 1,
    manufacturer: 'XiaoMi',
    emulatorStatus: 0,
    appMemory: '512',
    osVersion: '14',
    vendor: 'unknown',
    accelerometer: '1.4883357x9.80665x-0.1963501',
    sdRemain: 239600,
    buildTags: 'release-keys',
    packageName: 'com.mihoyo.hyperion',
    networkType: 'WiFi',
    oaid: '',
    debugStatus: 1,
    ramCapacity: '469679',
    magnetometer: '20.081251x-27.457501x2.1937501',
    display: `${profile.product}_13.1.0.181(CN01)`,
    appInstallTimeDiff: 1688455751496,
    packageVersion: APP_VERSION,
    gyroscope: '0.030226856x-0.014647375x-0.0013732915',
    batteryStatus: 100,
    hasKeyboard: 0,
    board: 'taro',
  };

  return JSON.stringify(extFields);
}

/**
 * 构建设备指纹请求体
 */
export function buildDeviceFpRequest(profile: DeviceInfo): DeviceFpRequest {
  return {
    device_id: profile.deviceId,
    seed_id: profile.seedId,
    seed_time: profile.seedTime,
    platform: '2',
    device_fp: profile.deviceFp,
    app_name: 'bbs_cn',
    ext_fields: buildDeviceExtFields(profile),
  };
}
