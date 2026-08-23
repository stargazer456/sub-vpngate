# vpngate-sstp-worker

一个 Cloudflare Worker：把 [VPN Gate](https://www.vpngate.net) 的公共服务器列表转换成 SSTP 订阅。
访问部署后的特定路径，即以纯文本输出全部可用节点，**每行一条**：

```
sstp://vpn:vpn@{hostname}.opengw.net:{Port}#{CountryShort}-{IP}
```

实际输出示例：

```
sstp://vpn:vpn@vpn182686651.opengw.net:443#JP-160.16.213.210
sstp://vpn:vpn@public-vpn-219.opengw.net:443#JP-133.11.226.163
sstp://vpn:vpn@land-th.opengw.net:995#TH-27.254.145.215
```

把订阅 URL 填进任何支持 SSTP 的客户端即可使用。

## 特性

- **单文件即可部署**：`dashboard-worker.js` 整份粘贴到 Cloudflare Dashboard 在线编辑器，无需 npm/wrangler
- **完整解析上游 CSV**：引号感知切分、主机名多形态归一化（详见[数据解析](#数据解析上游格式与坑)）
- **端口从 base64 OpenVPN 配置中解码**：取 `remote` 行的 host 与 port，权威可靠
- **边缘缓存 10 分钟** + 回源缓存，免费套餐轻松承载订阅轮询
- **上游故障兜底**：自动回退最近一次成功结果（最长 24 小时）
- **诊断模式**：`?debug=1` 返回解析统计与被跳过样本，线上问题一目了然
- **零依赖测试**：18 个离线用例（node:test），不联网即可验证全部解析逻辑

## 快速开始

### 方式一：Cloudflare Dashboard 部署（推荐）

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Create Worker**
2. 起个名字（如 `vpngate-sstp`）→ **Deploy** → **Edit code**
3. 在线编辑器中全选删除默认代码，粘贴 [`dashboard-worker.js`](./dashboard-worker.js) **全部内容** → **Deploy**
4. 访问 `https://vpngate-sstp.<你的子域>.workers.dev/sstp` 得到订阅文本

> 无需本地网络能访问 vpngate.net——抓取上游由 Cloudflare 边缘完成。
>
> **确认部署生效**：帮助页末尾有 `Version:` 行（或响应头 `X-Worker-Version`），
> 应与代码中的 `WORKER_VERSION` 常量一致。改完代码忘记重新 Deploy 是"怎么改都没变化"的最常见原因。

### 方式二：Wrangler CLI

```bash
npm install          # 安装 wrangler
npx wrangler login   # 登录 Cloudflare 账号
npm run deploy       # 部署（入口 src/index.js，逻辑与单文件版完全一致）
npm run dev          # 本地开发
```

## 接口

| 路径     | 说明                                  |
| -------- | ------------------------------------- |
| `/sstp`  | 输出节点列表（每行一条，纯文本）       |
| `/sstp/` | 同上（容忍尾斜杠）                     |
| 其他路径 | 404 帮助信息，**不暴露列表**           |

### 查询参数

| 参数                | 说明                                                         |
| ------------------- | ------------------------------------------------------------ |
| `?country=JP,HK,US` | 按 CountryShort 过滤（不区分大小写）                          |
| `?limit=50`         | 最多返回条数                                                  |
| `?sort=score\|speed`| 排序（默认保持上游顺序，即评分优先）                           |
| `?debug=1`          | 返回解析诊断 JSON（见下文），不输出列表                        |

### 响应头

| Header             | 说明                                        |
| ------------------ | ------------------------------------------- |
| `X-Cache`          | `HIT` / `MISS` / `DEBUG` / `STALE`          |
| `X-Node-Count`     | 过滤后节点数                                 |
| `X-Worker-Version` | 版本标记，用于确认部署生效                    |
| `Cache-Control`    | `public, max-age=600`                        |

### 诊断模式示例

```json
{
  "version": "3-diag",
  "upstreamBytes": 3512844,
  "totalLines": 642,
  "commentOrBlank": 3,
  "dataRows": 639,
  "parsed": 637,
  "skippedShortRow": 0,
  "skippedBadHostOrIp": 2,
  "skippedSamples": [
    { "name": "...", "reason": "host=..." }
  ]
}
```

## 数据解析：上游格式与坑

[`https://www.vpngate.net/api/iphone`](https://www.vpngate.net/api/iphone) 返回 UTF-8 纯文本 CSV：
前两行 `#` 注释、第三行表头（15 列，`OpenVPN_ConfigData_Base64` 为最后一列）、每行一台服务器、末行 `*EOF`。

三个关键点：

1. **端口不在明文里**。官方确认端口号编码在 base64 的 OpenVPN 配置文件中——
   解码后取 `remote <host> <port>` 行。该行的主机名是真正可连接的地址，
   **优先于 CSV 的 `#HostName` 列使用**。
2. **CSV 不完全规范**。`Operator`/`Message` 字段可能含带引号的逗号，需引号感知切分；
   base64 配置恒为最后一列且不含逗号，因此取最后一个字段最稳健。
3. **主机名形态多样**，归一化规则：

| `#HostName` 形态                       | 处理方式                              | 输出                    |
| -------------------------------------- | ------------------------------------- | ----------------------- |
| 完整 FQDN `vpn182686651.opengw.net`    | 统一小写                               | `vpn182686651.opengw.net` |
| 裸短名 `public-vpn-219` / `vpn123456` / `land-th` | 补全 `.opengw.net`         | `public-vpn-219.opengw.net` |
| 其他域名 `vpngate.dnc.ne.jp`           | 原样保留                               | `vpngate.dnc.ne.jp`     |

- remote 行省略端口、或该行完全没有 OpenVPN 配置时，端口按 SSTP/HTTPS 惯例默认 **443**
- 仅主机名完全无法确定（空值 / IPv4 字面量等）的行会被跳过，且可通过 `?debug=1` 观测到

## 缓存与容错

- 列表响应边缘缓存 10 分钟（上游约每 10 分钟刷新一次）
- 对上游的回源请求启用 `cacheTtl + cacheEverything`，降低对 vpngate.net 的压力
- 上游临时不可用时，回退到 isolate 内存中最近一次成功结果（`X-Cache: STALE`，最长 24 小时）
- 冷启动且上游不可用时返回 502

## 本地测试

```bash
npm test        # 或：node --test test/
node test/vpngate.test.js                 # 解析逻辑单测
node test/dashboard-worker.smoke.test.js  # 单文件版端到端冒烟测试
```

- 单测覆盖：CSV 引号解析、主机名归一化各形态、base64 解码取端口、
  多 `remote` 取第一条、无配置行默认 443、过滤排序等
- 冒烟测试 mock 上游与边缘缓存，直接调用 Worker 的 fetch 处理器，
  验证路由权限、输出逐字符比对、MISS→HIT 缓存、STALE 兜底与冷启动 502

## 自定义

| 想改什么         | 位置                                                       |
| ---------------- | ---------------------------------------------------------- |
| SSTP 用户名/密码 | `SSTP_USERNAME` / `SSTP_PASSWORD` 常量（SoftEther 默认 vpn:vpn） |
| 更隐蔽的订阅路径 | `LIST_PATHS` 常量，如 `new Set(['/sstp/my-token'])`         |
| 缓存时长         | `EDGE_CACHE_TTL` 秒数                                       |
| 版本标记         | `WORKER_VERSION`                                            |

## 常见问题

**Q：为什么个别节点连不上？**
无 OpenVPN 配置的行无法从数据层面确认其 SSTP 可用性，443 是按 SoftEther 公共中继惯例的推断值；公共节点本身也时好时坏，属正常现象。

**Q：为什么节点数比官网表格少 / 多？**
官网 HTML 表格与 CSV API 的收录和刷新时机不同；本项目忠实输出 CSV 中所有可解析的行。

**Q：免费套餐够用吗？**
够。重解析只在缓存未命中时发生，绝大多数请求直接命中边缘缓存。

## 目录结构

```
dashboard-worker.js   单文件版：整份粘贴到 Dashboard 在线编辑器即可部署
src/index.js          Wrangler 版入口：路由 / 缓存 / 过滤参数 / 兜底
src/lib/vpngate.js    纯函数库：CSV 切分、base64 解码、remote 提取、URI 拼装
test/                 两版的离线测试（node:test，零依赖）
wrangler.jsonc        Wrangler 配置（仅 CLI 部署需要）
```

## 免责声明

- 本项目仅做公开数据格式转换，不提供任何代理/翻墙服务本身；
- VPN Gate 数据由全球志愿者贡献，使用前请阅读并遵守
  [VPN Gate 使用条款](https://www.vpngate.net/en/aboutus.aspx)及你所在地的法律法规；
- 公共 VPN 节点安全性无法保证，请勿传输敏感信息。

## License

[MIT](./LICENSE)
