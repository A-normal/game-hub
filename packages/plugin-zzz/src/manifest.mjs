/**
 * @file packages/plugin-zzz/src/manifest.mjs
 * @description 绝区零纯指令路由清单 (严禁包含任何正则符号，前缀交由部署人员动态配置)
 */

import { handleBind } from "./handlers/bind.mjs";
import { handleSelectRole, handleListRoles } from "./handlers/role.mjs";
import { handleNote } from "./handlers/note.mjs";

/** @type {import('@game-hub/core').IGamePluginManifest} */
export const ZZZPluginManifest = {
  gameId: "zzz",
  name: "绝区零",
  community: "mihoyo",
  routes: [
    {
      id: "note",
      tokens: ["便签", "体力", "电量"],
      description: "查询绝区零实时电量与每日便签",
      action: handleNote
    },
    {
      id: "bind",
      tokens: ["绑定", "添加账号"],
      description: "绑定米游社通行证并发现游戏角色",
      action: handleBind
    },
    {
      id: "selectRole",
      tokens: ["选角色", "切换角色", "设置角色"],
      description: "切换当前绑定的绝区零主角色",
      action: handleSelectRole
    },
    {
      id: "listRoles",
      tokens: ["角色列表", "我的角色", "角色清单"],
      description: "查看已绑定的全部绝区零角色",
      action: handleListRoles
    }
  ]
};

export default ZZZPluginManifest;
