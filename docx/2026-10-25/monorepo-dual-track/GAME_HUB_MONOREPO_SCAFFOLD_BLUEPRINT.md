# Game-Hub 新仓库 Monorepo 脚手架与核心契约实施蓝图
## (Monorepo Starter Blueprint, Package JSONs & Interface Declarations)

- **归档路径**: `docx/2026-10-25/monorepo-dual-track/GAME_HUB_MONOREPO_SCAFFOLD_BLUEPRINT.md`
- **目标**: 为即将新建的独立 Monorepo 仓库提供开箱即用的工程配置、包契约文件与代码骨架。

---

## 一、 根目录配置模板 (Root Configurations)

### 1.1 `pnpm-workspace.yaml`
```yaml
packages:
  - "packages/*"
```

### 1.2 `package.json` (Root)
```json
{
  "name": "game-hub-monorepo",
  "version": "1.0.0",
  "private": true,
  "description": "Game-Hub: Pluggable Multi-Community Game Bus with Dual-Track Channel Support",
  "type": "module",
  "scripts": {
    "build": "pnpm -r --filter=!gateway-yunzai run build",
    "test": "node --test tests/**/*.test.mjs || pnpm -r test",
    "lint": "eslint packages/*/src",
    "dev:standalone": "pnpm --filter @game-hub/gateway-standalone dev",
    "clean": "pnpm -r exec rm -rf node_modules dist"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  },
  "packageManager": "pnpm@9.12.0"
}
```

### 1.3 `tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
```

---

## 二、 核心微内核包：`packages/core` (`@game-hub/core`)

### 2.1 `packages/core/package.json`
```json
{
  "name": "@game-hub/core",
  "version": "1.0.0",
  "description": "Game-Hub Core Microkernel: Dispatcher, Inbound Shaper, Identity Vault, and SPI Interfaces",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "node --test test/**/*.test.mjs"
  },
  "dependencies": {
    "yaml": "^2.6.0"
  }
}
```

### 2.2 `packages/core/src/types/index.ts` (核心接口契约)
```typescript
/**
 * 渠道归一化入站事件接口
 */
export interface IUnifiedEvent {
  platform: 'qq-napcat' | 'telegram' | 'qqbot' | 'satori' | 'mock';
  unifiedUserId: string;     // 规范化用户主键 (如 "qq:123456", "tg:987654321")
  rawText: string;           // 原始输入
  cleanText: string;         // 剥离 @Bot 后的干净文本
  isGroup: boolean;
  groupId?: string;
  sender: {
    id: string;
    name: string;
    role?: 'owner' | 'admin' | 'member';
  };
  // 自适应回复代理
  reply: (content: string | IAdaptiveMessage, options?: IReplyOptions) => Promise<any>;
}

export interface IReplyOptions {
  quote?: boolean;
  at?: boolean;
}

export interface IAdaptiveMessage {
  type: 'markdown' | 'text' | 'image' | 'node';
  content: string;
  fallbackImageUrl?: string;
}

/**
 * 社区驱动标准 SPI 接口
 */
export interface ICommunityProvider {
  id: string;   // 如 "mihoyo", "kuro"
  name: string; // 如 "米游社", "库街区"
  
  createLoginQrCode?: () => Promise<{ qrUrl: string; checkTicket: () => Promise<any> }>;
  refreshSession?: (credentials: any) => Promise<any>;
  requestGateway: (options: IGatewayRequestOptions) => Promise<any>;
}

export interface IGatewayRequestOptions {
  url: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: any;
  headers?: Record<string, string>;
  credentials?: {
    cookie?: string;
    deviceId?: string;
    deviceFp?: string;
  };
}

/**
 * 纯游戏插件元数据与路由清单
 */
export interface IGamePluginManifest {
  gameId: string;           // 如 "zzz", "hsr", "wuwa"
  name: string;             // 如 "绝区零", "鸣潮"
  community: string;        // 所需的底层社区驱动 id，如 "mihoyo", "kuro"
  routes: IGameRoute[];
}

export interface IGameRoute {
  id: string;               // 内部路由 ID，如 "note", "code"
  tokens: string[];         // 纯语义指令词元，严禁带 regex 符号 (如 ["便签", "体力"])
  action: (ctx: IGameContext) => Promise<boolean | 'return' | void>;
  description?: string;
}

export interface IGameContext {
  event: IUnifiedEvent;
  gameId: string;
  matchedToken: string;
  args: string[];
  provider?: ICommunityProvider;
  credentials?: any;
}
```

---

## 三、 社区驱动包：`packages/provider-mihoyo`

### 3.1 `packages/provider-mihoyo/package.json`
```json
{
  "name": "@game-hub/provider-mihoyo",
  "version": "1.0.0",
  "description": "Mihoyo Community Provider for Game-Hub: DS1/DS2 Dynamic Signatures & Takumi API Gateway",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@game-hub/core": "workspace:*",
    "undici": "^6.20.0"
  }
}
```

### 3.2 驱动导出标准示例 (`src/index.ts`)
```typescript
import { ICommunityProvider, IGatewayRequestOptions } from '@game-hub/core';
import crypto from 'node:crypto';

export class MihoyoCommunityProvider implements ICommunityProvider {
  id = 'mihoyo';
  name = '米游社';

  private salt = 'xV8vVuOBqIOB00nugrIZug1xxBLOuWKK'; // 2.71.1 DS1 Salt

  getDs1(query = '', body = ''): string {
    const t = Math.floor(Date.now() / 1000);
    const r = Math.random().toString(36).substring(2, 8);
    const hash = crypto.createHash('md5').update(`salt=${this.salt}&t=${t}&r=${r}&b=${body}&q=${query}`).digest('hex');
    return `${t},${r},${hash}`;
  }

  async requestGateway(options: IGatewayRequestOptions): Promise<any> {
    const ds = this.getDs1(new URLSearchParams(options.query || {}).toString());
    const headers = {
      'x-rpc-app_version': '2.71.1',
      'x-rpc-client_type': '5',
      'DS': ds,
      'Cookie': options.credentials?.cookie || '',
      ...(options.headers || {})
    };

    // 发起安全网关调用
    const resp = await fetch(options.url, { method: options.method || 'GET', headers });
    return resp.json();
  }
}

export default MihoyoCommunityProvider;
```

---

## 四、 纯游戏业务包：`packages/plugin-zzz`

### 4.1 `packages/plugin-zzz/package.json`
```json
{
  "name": "@game-hub/plugin-zzz",
  "version": "1.0.0",
  "description": "Zenless Zone Zero Pure Business Plugin for Game-Hub",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@game-hub/core": "workspace:*"
  }
}
```

### 4.2 业务插件导出示例 (`src/index.ts`)
```typescript
import { IGamePluginManifest, IGameContext } from '@game-hub/core';

export const ZZZPluginManifest: IGamePluginManifest = {
  gameId: 'zzz',
  name: '绝区零',
  community: 'mihoyo',
  routes: [
    {
      id: 'note',
      tokens: ['便签', '体力', '电量'],
      description: '查询绝区零实时电量与便签',
      action: async (ctx: IGameContext) => {
        // 纯业务逻辑：完全不需要关心是来自 QQ 还是 Telegram，不需要写正则匹配
        await ctx.event.reply('【绝区零便签】当前电量: 240/240 (已回满)', { quote: true });
        return 'return';
      }
    },
    {
      id: 'code',
      tokens: ['兑换码', 'code', '前瞻码'],
      description: '查询最新版本前瞻兑换码',
      action: async (ctx: IGameContext) => {
        await ctx.event.reply('【绝区零前瞻直播兑换码】暂无最新资讯。', { quote: true });
        return 'return';
      }
    }
  ]
};

export default ZZZPluginManifest;
```

---

## 五、 双轨通道实现骨架

### 5.1 轨道 A：云崽极简桥接器 (`packages/gateway-yunzai`)
```typescript
import { GameHubDispatcher, InboundShaper } from '@game-hub/core';

const PluginBase = (global as any).plugin || class { constructor(opts: any) { Object.assign(this, opts); } };

export class YunzaiDispatcherApp extends PluginBase {
  constructor(private dispatcher: GameHubDispatcher) {
    super({
      name: 'Game-Hub:分发总线',
      dsc: '前置拦截并派发至 Game-Hub 微内核',
      event: 'message',
      priority: -1000,
      rule: [{ reg: '.*', fnc: 'dispatch', log: false }]
    });
  }

  async dispatch(e: any) {
    const unifiedEvent = InboundShaper.shape(e);
    const result = await this.dispatcher.dispatch(unifiedEvent);
    if (result === 'return' || result === true) {
      return 'return'; // 掐断云崽后续一切无关插件
    }
    return false;
  }
}
```

### 5.2 轨道 B：原生独立去云崽网关 (`packages/gateway-standalone`)
```typescript
import { GameHubDispatcher, IUnifiedEvent } from '@game-hub/core';
import { WebSocketServer } from 'ws';

export class StandaloneGateway {
  constructor(private dispatcher: GameHubDispatcher) {}

  startOneBotReverseWs(port = 8080) {
    const wss = new WebSocketServer({ port });
    console.log(`[Standalone Gateway] Listening NapCat ws-reverse on :${port}`);

    wss.on('connection', (ws) => {
      ws.on('message', async (data) => {
        const payload = JSON.parse(data.toString());
        if (payload.post_type === 'message') {
          // 归一化 NapCat 原生事件
          const unifiedEvent: IUnifiedEvent = {
            platform: 'qq-napcat',
            unifiedUserId: `qq:${payload.user_id}`,
            rawText: payload.raw_message,
            cleanText: payload.message?.filter((m: any) => m.type === 'text').map((m: any) => m.data.text).join('') || '',
            isGroup: payload.message_type === 'group',
            groupId: payload.group_id?.toString(),
            sender: { id: payload.user_id.toString(), name: payload.sender?.nickname || '' },
            reply: async (msg) => {
              ws.send(JSON.stringify({
                action: 'send_msg',
                params: {
                  message_type: payload.message_type,
                  user_id: payload.user_id,
                  group_id: payload.group_id,
                  message: typeof msg === 'string' ? msg : msg.content
                }
              }));
            }
          };

          // 注入微内核调度
          await this.dispatcher.dispatch(unifiedEvent);
        }
      });
    });
  }
}
```

---

## 六、 部署人员配置文件模板 (`config/namespaces.yaml`)

```yaml
# ==============================================================================
# Game-Hub 部署人员动态命名空间配置文件 (Deployer Namespaces Configuration)
# ==============================================================================

namespaces:
  zzz:
    prefix: "*"               # 绝区零前缀
    aliases:
      - "zzz"
      - "ZZZ"
      - "绝区零"
    priority: 100
    allow_bare_keywords: false

  wuwa:
    prefix: "/"               # 鸣潮前缀
    aliases:
      - "wuwa"
      - "鸣潮"
      - "mc"
    priority: 80
    allow_bare_keywords: false
```
