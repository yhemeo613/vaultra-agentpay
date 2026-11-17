# Vaultra · AgentPay 官网与基础设施

`agentpay-site/` 是 AgentPay 项目的产品官网 + 使用文档 + 在线演示 + 服务商后台。

## 页面

| 页面 | 内容 |
|---|---|
| `index.html` | 首页：hero（粒子地球）+ 产品介绍 + 工作原理 5 步 + 安全防线表 + CTA |
| `docs.html` | 使用文档：快速开始 / 架构 / SDK 接入 / 合约 API / 部署 / 服务商接入 / 安全模型 / FAQ |
| `demo.html` | 在线演示：浏览器端跑 402 全流程 + 攻击面演示（需本地链 + 网关） |
| `provider.html` | 服务商后台：概览 / 服务管理 / 托管台账 / 合约参数（需 provider-admin API） |

## 运行

```bash
# 1) 官网静态站（默认 4023）
node agentpay-site/serve.js

# 2) 服务商后台 API（默认 4022；需要链与合约在跑）
node agentpay-site/provider-admin/server.js
# 环境变量：AGENTPAY_ADDRESS / TOKEN_ADDRESS / RPC_URL / PROVIDER_PRIVATE_KEY / OWNER_PRIVATE_KEY / ADMIN_TOKEN / SERVICE_IDS

# 3) 本地链 + 网关（demo.html 演示依赖）
npx hardhat node
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/register-service.js --network localhost
node demo/server.js                 # 浏览器演示请用 REQUIRE_TLS=0
```

打开 `http://127.0.0.1:4023/`。

## 服务商后台说明

后台数据**全部来自链上事件**（Paid/Claimed/Refunded/Disputed/Resolved），从部署区块开始重建台账，
不经过任何中间人数据库。支持的操作用私钥直接签链上交易：

- 服务管理：`setService` / `closeService`（provider 私钥）
- 托管结算：`claim`（provider 私钥）
- 合约参数：`setFee` / `setRefundDelay` / `setTreasury` / `setArbiter`（owner 私钥）

本地演示不设 `ADMIN_TOKEN`（API 无鉴权，仅限本机）；生产必须设置。

## 安全说明

- 网关的 CORS 是 `*`（为本地演示页 demo.html 跨源调用），**生产网关应去掉**或改白名单。
- 演示页 `demo.html` 内嵌了一个 hardhat 测试私钥，只用于本地链演示；测试网/主网请换自己的测试钱包，且不要把真私钥放页面里。
- 后台 API 与网关都是本地服务，不要直接暴露公网。
