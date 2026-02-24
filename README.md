# openclaw-wecom-kf

微信客服（WeCom Customer Service）渠道插件，让外部微信用户通过企业微信客服系统与 OpenClaw AI 智能体交互。

## 与 wecom-app 的区别

| | wecom-app (企微自建应用) | wecom-kf (微信客服) |
|---|---|---|
| 面向用户 | 企业内部员工 | 外部微信用户（客户） |
| 用户标识 | `userid`（内部工号） | `external_userid`（微信开放ID） |
| 应用标识 | `agentId`（数字） | `openKfId`（字符串，如 `wkxxxxxx`） |
| 回调机制 | 回调直接携带消息内容 | 回调仅通知，需调用 `sync_msg` 拉取消息 |
| 发送接口 | `/cgi-bin/message/send` | `/cgi-bin/kf/send_msg` |
| 欢迎消息 | 直接文本回复 | 通过 `send_msg_on_event` + `welcome_code` |
| 发送限制 | 无特殊限制 | 48小时窗口期内最多5条消息 |
| Markdown | 支持 | 不支持（纯文本） |

## 安装

### 方式一：本地构建安装

```bash
# 1. 克隆仓库
git clone https://github.com/<your-org>/openclaw-wecom-kf.git
cd openclaw-wecom-kf

# 2. 安装依赖并构建
npm install
npm run build

# 3. 复制到 OpenClaw 扩展目录
mkdir -p ~/.openclaw/extensions/wecom-kf
cp -r dist package.json openclaw.plugin.json ~/.openclaw/extensions/wecom-kf/

# 4. 在 ~/.openclaw/openclaw.json 中注册插件
#    编辑 plugins 部分，添加 "wecom-kf"：
```

编辑 `~/.openclaw/openclaw.json`，在 `plugins` 部分添加：

```jsonc
{
  "plugins": {
    "allow": [
      "channels",    // 已有
      "wecom-kf"     // 新增
    ],
    "entries": {
      "channels": { "enabled": true },   // 已有
      "wecom-kf": { "enabled": true }    // 新增
    }
  }
}
```

### 方式二：直接复制 dist

如果你已经有构建好的产物，只需要三个文件：

```
~/.openclaw/extensions/wecom-kf/
├── dist/
│   └── index.js          # 构建产物
├── package.json           # 包描述
└── openclaw.plugin.json   # 插件清单
```

### 验证安装

```bash
openclaw plugins list
```

应看到 `wecom-kf` 状态为 `loaded`：

```
│ WeCom KF     │ wecom-kf │ loaded   │ global:wecom-kf/dist/index.js │ 0.1.0 │
```

## 企业微信后台配置

### 第一步：创建客服账号

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame)
2. 进入 **应用管理** → **微信客服**
3. 点击 **创建客服账号**，记下客服账号 ID（`open_kfid`，格式如 `wkxxxxxxxxxxxxxxxx`）

### 第二步：创建 API 应用（获取 Secret）

微信客服需要一个专用的 **Secret** 来调用 API：

1. 在管理后台进入 **应用管理** → **微信客服**
2. 找到页面底部的 **API** 部分
3. 记下 **Secret**（即 `corpSecret`）
4. 记下页面顶部的 **企业ID**（即 `corpId`）

> 注意：微信客服的 Secret 与自建应用的 Secret 不同，需要单独获取。

### 第三步：配置回调地址

1. 在微信客服 API 设置中，找到 **回调配置**
2. 设置 **URL**：`https://your-domain.com/wecom-kf`（需要外网可访问）
3. 设置 **Token**：自定义一个字符串（记下来）
4. 设置 **EncodingAESKey**：点击随机生成（记下来）
5. 点击 **保存**，企业微信会向你的 URL 发送 GET 验证请求

> 确保 OpenClaw 网关已启动且回调 URL 可从公网访问。可使用 Tailscale Funnel、ngrok、Cloudflare Tunnel 等内网穿透工具。

### 第四步：获取客服链接

1. 在客服账号详情页，找到 **客服链接**
2. 将链接分享给客户或嵌入网页/公众号菜单
3. 微信用户点击链接即可开始与 AI 客服对话

## OpenClaw 配置

在 `~/.openclaw/openclaw.json` 的 `channels` 部分添加 `wecom-kf` 配置：

### 基本配置

```jsonc
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      "corpId": "ww1234567890abcdef",        // 企业ID
      "corpSecret": "your-kf-secret-here",    // 微信客服 Secret
      "openKfId": "wkABCDEF1234567890",       // 客服账号 ID
      "token": "your-callback-token",          // 回调 Token
      "encodingAESKey": "your-encoding-aes-key", // 回调加密密钥
      "webhookPath": "/wecom-kf",              // 回调路径（默认 /wecom-kf）
      "welcomeText": "你好！我是 AI 客服，请问有什么可以帮您？"  // 欢迎语（可选）
    }
  }
}
```

### 环境变量（可选）

默认账户支持通过环境变量配置，适合 Docker 等场景：

```bash
export WECOM_KF_CORP_ID="ww1234567890abcdef"
export WECOM_KF_CORP_SECRET="your-kf-secret-here"
export WECOM_KF_OPEN_KF_ID="wkABCDEF1234567890"
export WECOM_KF_TOKEN="your-callback-token"
export WECOM_KF_ENCODING_AES_KEY="your-encoding-aes-key"
```

### 多账户配置

如果需要管理多个客服账号：

```jsonc
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      "corpId": "ww1234567890abcdef",
      "corpSecret": "your-kf-secret-here",
      "accounts": {
        "sales": {
          "openKfId": "wkSALES1234567890",
          "token": "sales-token",
          "encodingAESKey": "sales-aes-key",
          "webhookPath": "/wecom-kf/sales",
          "welcomeText": "欢迎咨询！请问您对哪款产品感兴趣？"
        },
        "support": {
          "openKfId": "wkSUPPORT1234567890",
          "token": "support-token",
          "encodingAESKey": "support-aes-key",
          "webhookPath": "/wecom-kf/support",
          "welcomeText": "您好，技术支持为您服务。"
        }
      }
    }
  }
}
```

### 安全策略

```jsonc
{
  "channels": {
    "wecom-kf": {
      "enabled": true,
      // ...其他配置...
      "dmPolicy": "open",        // "open"=所有人, "allowlist"=白名单, "disabled"=禁用
      "allowFrom": [             // 当 dmPolicy 为 "allowlist" 时生效
        "wmXXXXXX_external_userid_1",
        "wmXXXXXX_external_userid_2"
      ]
    }
  }
}
```

### 入站媒体配置

```jsonc
{
  "channels": {
    "wecom-kf": {
      // ...其他配置...
      "inboundMedia": {
        "enabled": true,                           // 是否保存客户发送的图片/语音/文件
        "dir": "/home/user/.openclaw/media/wecom-kf/inbound",  // 保存目录
        "maxBytes": 10485760,                      // 单文件最大 10MB
        "keepDays": 7                              // 自动清理7天前的文件
      }
    }
  }
}
```

## 完整配置参考

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | boolean | 否 | `true` | 是否启用 |
| `corpId` | string | **是** | - | 企业 ID |
| `corpSecret` | string | **是** | - | 微信客服 Secret |
| `openKfId` | string | **是** | - | 客服账号 ID (`wkXXX`) |
| `token` | string | **是** | - | 回调 Token |
| `encodingAESKey` | string | **是** | - | 回调消息加密密钥 |
| `webhookPath` | string | 否 | `/wecom-kf` | 回调 URL 路径 |
| `welcomeText` | string | 否 | - | 用户进入会话时的欢迎语 |
| `dmPolicy` | string | 否 | `open` | DM 策略：`open`/`allowlist`/`disabled` |
| `allowFrom` | string[] | 否 | `[]` | 允许的 external_userid 列表 |
| `apiBaseUrl` | string | 否 | `https://qyapi.weixin.qq.com` | API 地址（用于代理） |
| `inboundMedia.enabled` | boolean | 否 | `true` | 是否保存入站媒体 |
| `inboundMedia.dir` | string | 否 | `~/.openclaw/media/wecom-kf/inbound` | 媒体保存目录 |
| `inboundMedia.maxBytes` | number | 否 | `10485760` | 单文件最大字节数 |
| `inboundMedia.keepDays` | number | 否 | `7` | 文件保留天数 |

## 工作原理

```
微信用户 → 微信客服 → 企业微信服务器 → 回调通知(POST) → OpenClaw 网关
                                                            ↓
                                                     解密回调 XML
                                                     提取 Token
                                                            ↓
                                                     sync_msg 拉取消息
                                                     (cursor 分页轮询)
                                                            ↓
                                                     去重 + 过滤
                                                     (仅处理 origin=3 客户消息)
                                                            ↓
                                                     路由到 AI Agent
                                                     (resolveAgentRoute)
                                                            ↓
                                                     Agent 生成回复
                                                     (dispatchReply)
                                                            ↓
                                                     send_msg 发送回复
                                                     (stripMarkdown + 分段)
                                                            ↓
微信用户 ← 微信客服 ← 企业微信服务器 ← ─────────────────────────┘
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 监听模式开发
npm run dev
```

### 项目结构

```
src/
├── index.ts          # 插件入口，default export，register()
├── types.ts          # 所有类型定义
├── config.ts         # 账户配置解析，DM 策略
├── crypto.ts         # WeCom 签名验证 + AES 加解密
├── api.ts            # access_token 缓存，sync_msg，send_msg，媒体上传/下载
├── webhook.ts        # HTTP 处理：GET 验证 + POST 回调 → 异步消息拉取
├── bot.ts            # 入站消息内容提取 + 媒体下载
├── dispatch.ts       # 消息分发到 OpenClaw 运行时
├── channel.ts        # ChannelPlugin 定义（meta, capabilities, outbound, gateway）
├── send.ts           # 便捷发送封装（sendWecomKfDM）
└── runtime.ts        # 运行时单例管理
```

## 常见问题

### 回调验证失败

- 确认 `token` 和 `encodingAESKey` 与企业微信后台配置完全一致
- 确认 `webhookPath` 与回调 URL 的路径部分匹配
- 确认 OpenClaw 网关端口已开放且可从公网访问

### 消息发送失败

- 确认 `corpId`、`corpSecret`、`openKfId` 配置正确
- 确认客服 Secret 有调用 `kf/send_msg` 的权限
- 注意 48 小时窗口期限制：客户最后一次发消息后 48 小时内才能回复，且限 5 条

### 收不到消息

- 确认回调 URL 已在企业微信后台配置并验证通过
- 查看 OpenClaw 日志中是否有 `[wecom-kf]` 相关输出
- 确认消息拉取正常：日志中应看到 `callback received` 和 `sync_msg` 调用

## License

MIT
