# AgentPay (AGP)

AI Agent 按次计费的 BEP-20 代币 + 链上结算层，跑在 BNB Smart Chain 上。

一句话：**每个 agent 调用付一次钱，链上托管结算，中间商只抽 0.5%，付了没交付可以退款，扯皮可以仲裁。**

---

## 为什么是这套设计

BSC 的 gas 低到单笔几百美元以下级别的调用都划得来，这是以太坊做不到的。所以这个币的"用途"不是讲故事，
而是真的能承载 **高频微支付**：

- 服务方（agent 运营者）注册服务、定价、出具 endpoint
- 调用方拿到 402 后签发 challenge，付款时把 challengeId 写进链上 `memo`（资金进**托管**），
  再用 EIP-712 对同一个 challengeId 签名
- 服务方交付成功后 `claim()` 结算（0.5% 进财库）
- 超时未交付，付款方 `refund()` 原路退回
- 交付前有争议，付款方 `dispute()` 冻结托管，**仲裁人 `resolve()` 裁决**归谁
- 合约只在托管期持有资金，结算/退款/裁决后**余额恒为 0**

## 托管生命周期（合约状态机）

```
             pay()                 claim()
  付款方 ──────────► OPEN ──────────────────► CLAIMED（服务方拿 net，财库拿 fee）
                       │
                       │ 超时未结算           dispute()
                       ▼                       │
                     refund() ◄────────────────┴────────► DISPUTED（冻结）
                       │                                  │
                       ▼                                  │ resolve(memo, toProvider)
                     REFUNDED（原额退回）                   ├─ true  → 按 claim 分配（RESOLVED）
                                                          └─ false → 原额退回付款方（RESOLVED）
```

状态机：`OPEN → CLAIMED / REFUNDED / DISPUTED → RESOLVED`。
`claim` 只有该服务 provider 能调；`refund`/`dispute` 只有原付款人能调；`resolve` 只有仲裁人能调。
进入 DISPUTED 后 claim 和 refund 全部冻结，只有仲裁裁决能解锁。

## 核心链路

```
agent                          server                          BSC
  |  GET/POST /v1/infer          |                               |
  |----------------------------->|                               |
  |  402 + challenge             |  nonce + reqHash + expiresAt  |
  |<-----------------------------|                               |
  |                                                              |
  |  pay(serviceId, calls, challengeId)  ----------------------->|
  |  (challengeId 作为 memo，资金进托管)     Paid event            |
  |<--------------------------------------------------------------|
  |                                                              |
  |  POST + X-PAYMENT-TX / -CHALLENGE / -SIGNATURE（HTTPS/mTLS）  |
  |----------------------------->|                               |
  |                              |  ① challenge 存在、未用、未过期（store）|
  |                              |  ② 客户端身份一致（证书指纹 / IP+UA）   |
  |                              |  ③ 请求指纹一致                     |
  |                              |  ④ EIP-712 验签 == Paid.payer      |
  |                              |  ⑤ 交付成功 -> claim() 结算（分布式锁幂等）|
  |  200 + 结果（billing.settlement）|                                |
  |<-----------------------------|                               |
```

防线矩阵：

| 攻击 | 防线 | 状态 |
|---|---|---|
| 不付款直接调 | 402 拦截 | ✅ 实测 |
| 一笔 tx 服务多个请求 | `memo == challengeId` + challenge 一次性 | ✅ 实测 |
| 换 prompt 复用付款 | challenge 绑定 `reqHash`（method+path+body） | ✅ 实测 |
| 原样重放 | challenge 核销 + 过期 | ✅ 实测 |
| 截获 txHash 冒充付款人 | EIP-712 签名者 == 链上 `Paid.payer` | ✅ 实测 |
| 截获完整报文从别处重放 | challenge 绑定客户端身份，身份不符拒绝且不消耗 | ✅ 实测 |
| 付了钱不交付 | 托管 escrow，超时 `refund()` 原路退回 | ✅ 实测 |
| 交付争议 | `dispute()` 冻结 → 仲裁人 `resolve()` 裁决 | ✅ 实测（双向） |
| 多实例重复结算 | `store.setNx` 分布式锁，`claim` 幂等 | ✅ 测试 |

## 四件事的落地方式

| 之前的缺口 | 现在的做法 |
|---|---|
| challenge 存内存，重启失效 | store 层：`memory` / `sqlite` / `redis`，统一契约，`setNx` 原子锁 |
| 头部窃听，报文可跨客户端重放 | HTTPS 强制 + mTLS + challenge 绑定客户端身份 |
| 付款即终局，无退款 | escrow：`pay` 进托管 → `claim`/`refund`，等待期 1h–30d 可配 |
| 交付扯皮无仲裁 | `dispute` + 独立仲裁人 `resolve`，判服务方或判付款方 |
| 推理是 mock | OpenAI 兼容接口（`LLM_BASE_URL`），未配置回退 mock |

## 目录结构

```
agentpay/
├── contracts/
│   ├── AgentToken.sol        # BEP-20，固定 10 亿枚，零税、无 mint/黑名单/pause
│   └── AgentPay.sol          # 服务注册 + 托管结算 + 仲裁（pay/claim/refund/dispute/resolve）
├── sdk/
│   ├── challenge.js          # challenge 唯一真源（两端共用）
│   ├── signature.js          # EIP-712 付款确认签名
│   ├── http.js               # 极小的 HTTP 客户端，支持 TLS/mTLS
│   ├── inference.js          # OpenAI 兼容推理 + mock 回退
│   └── agentpay-client.js    # 402 -> 付款 -> 签名 -> 重试（POST/GET）
├── store/
│   ├── memory.js / sqlite.js / redis.js / index.js   # STORE=memory|sqlite|redis，含 setNx
├── scripts/
│   ├── deploy.js             # 财库/仲裁人可用环境变量覆盖
│   ├── register-service.js
│   └── make-certs.js         # 生成本地 HTTPS/mTLS 自签名证书
├── demo/
│   ├── server.js             # 402 网关（GET/POST、分布式锁结算）
│   ├── client.js             # 单次调用 + 五攻击面演示
│   ├── agent.js              # agent 自动付费循环
│   ├── refund.js             # 退款演示（evm 拨快时间）
│   └── dispute.js            # 仲裁演示（两个方向）
├── test/                     # 合约 28 + 协议 11 + store 15 + 推理 5 = 59
├── certs/                    # 生成后自动 gitignore
└── .env.example
```

## 快速开始（本地，无需真实资产）

```bash
npm install
npm run certs
npx hardhat test                    # 59 passing

# 终端 A
npx hardhat node

# 终端 B
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/register-service.js --network localhost
$env:STORE="redis"; $env:REDIS_URL="redis://127.0.0.1:6379"
$env:REQUIRE_TLS="1"; $env:TLS_CERT="certs/server.crt"; $env:TLS_KEY="certs/server.key"
$env:PROVIDER_PRIVATE_KEY="<服务方钱包私钥>"
node demo/server.js

# 终端 C
$env:ENDPOINT="https://127.0.0.1:4021/v1/infer"
node demo/client.js "为什么 BSC 适合做 agent 微支付"
node demo/dispute.js                 # 仲裁两方向
node demo/agent.js
node demo/refund.js                  # 最后跑：拨快本地链时间
```

`deploy.js` 在本地链（chainId 31337）会自动给前 3 个测试账户各发 10000 AGP。
本地 demo 的财库/仲裁人默认是部署者；**生产必须**用 `TREASURY_ADDRESS` / `ARBITER_ADDRESS` 指定多签。

期望输出（client.js，POST）：

```
[1] 未付款请求 -> HTTP 402
[2] 付款（资金进托管）并签名
[3] 换一把私钥签名 -> 402 签名者与付款人不一致
[4] 换 prompt -> 402 绑定的是另一个请求
[5] 换客户端身份 -> 403 不能跨客户端使用
[6] 正确请求 -> 200 billing.settlement = claimed
[7] 原样重放 -> 402 已核销
```

dispute.js 期望输出：

```
== 第一笔：仲裁判服务方胜 ==
  dispute 后: caller=9996 · provider=999970002 · contract=2.0
  结果 state=RESOLVED: caller=9996 · provider=999970003 · contract=1.0
== 第二笔：仲裁判付款方胜 ==
  结果 state=RESOLVED: caller=9996 · provider=999970003 · contract=1.0
```

## 测试网 / 主网部署

```bash
cp .env.example .env            # PRIVATE_KEY 用专用测试钱包
npm run deploy:testnet          # 或 deploy:mainnet
npm run register:testnet
npx hardhat verify --network bscTestnet <tokenAddress>
npx hardhat verify --network bscTestnet <agentPayAddress> <tokenAddress> <treasury> <arbiter>
```

- 测试币水龙头：<https://www.bnbchain.org/en/testnet-faucet>（0.3 tBNB/天）
- 浏览器：<https://testnet.bscscan.com>，链 ID 97
- 主网部署 gas 约 150 万单位，成本通常 $0.05–$0.30

**上线前必做：** 1) BscScan 验证源码；2) 建 PancakeSwap V2 池并锁 LP；
3) `setRefundDelay()` 调业务窗口；4) 财库与仲裁人换成多签；5) 第三方审计。

## 合约设计要点

| 决策 | 原因 |
|---|---|
| 没有 `mint()` / 黑名单 / pause / 交易税 | 信任资产：总量固定、无人能冻结、买卖一致 |
| `pay(id, calls, memo)` 进托管 | 资金由合约保管，出口权限各有限制 |
| `DuplicateMemo` 拒绝 | 防止同一 memo 二次付款覆盖托管 |
| 状态机 + `BadState` | 明确每个动作的合法时机，杜绝越权结算 |
| `claim` 只限 provider、`refund`/`dispute` 只限 payer | 三方权限边界 |
| `resolve` 只限仲裁人，且只在 DISPUTED | 争议冻结后只有仲裁能解锁 |
| 合约不沉淀余额 | 结算/退款/裁决后归零；owner 无 withdraw |
| EVM target 锁 `paris` | BSC 对新 opcode 支持滞后 |

## 代币分配（10 亿枚）

| 分配 | 比例 | 解锁 |
|---|---|---|
| 流动性 | 35% | 建池即入，LP 锁 12 个月 |
| 社区空投 / 调用激励 | 25% | 24 个月线性，按真实调用量发放 |
| Agent 开发者补贴 | 15% | 12 个月线性 |
| 团队 | 15% | 12 个月 cliff + 24 个月线性 |
| 财库（多签） | 10% | 3/5 多签控制 |

## 已知边界（诚实说明）

- **仲裁是"信任仲裁人"的单点**：`resolve` 只有仲裁人一个地址能调。更去中心化的方案是多签仲裁团
  （几个地址联合裁决）或链下争议委员会 + 链上执行。单仲裁人对 demo 够用，生产建议至少多签。
- **仲裁无时限**：DISPUTED 状态没有超时，需要业务层约定仲裁时限，否则资金永久冻结。
- **自动 claim 的服务方私钥在环境变量里**：生产应放 KMS / 安全凭据服务。
- **网关无状态，多实例共享 redis**：`setNx` 锁已防重复 claim；但 `claim-lock` 的 60s TTL
  是保守值，结算慢于 60s 的极端情况可能重复尝试（合约 `BadState` 兜底，不是漏洞）。
- **挑战-应答仍是 HTTP 头传递**：HTTPS + mTLS 解决窃听与身份；密钥与证书安全是前置条件。
- **合约未审计**：上主网前请自行审计或找审计方过一遍。

## 风险提示

- 代币的经济价值取决于有没有人真的用它付费；发币本身不创造需求。
- 面向中国大陆公众的代币发行融资有明确法律风险，境外也涉及证券认定、KYC/AML 与税务。
- 不要把主钱包私钥写进 `.env`；`.env` 与 `certs/` 已在 `.gitignore` 中。

