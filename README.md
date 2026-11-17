# Vaultra · AgentPay

**让 AI Agent 自己付钱** —— 跑在 BNB Smart Chain 上的按次计费基础设施。

每个 agent 调用付一次钱，链上托管结算，付了没交付可以退款，扯皮可以仲裁。402 挑战-应答协议，人类无需介入。

[![tests](https://img.shields.io/badge/tests-59%20passing-brightgreen)]() [![license](https://img.shields.io/badge/license-MIT-blue)]() [![chain](https://img.shields.io/badge/chain-BNB%20Smart%20Chain-F0B90B)]()

## 这是什么

| 部分 | 目录 | 说明 |
|---|---|---|
| 合约 + SDK + 网关 | [`agentpay/`](agentpay/) | BEP-20 代币、escrow 结算合约、402 计费网关、agent SDK、59 个测试 |
| 官网 + 文档 + 演示 + 后台 | [`agentpay-site/`](agentpay-site/) | 产品官网、使用文档、浏览器端在线演示、服务商后台 |

核心能力：

- **托管结算**：`pay()` 进托管 → 交付后 `claim()`（0.5% 平台费）→ 超时 `refund()` 原路退回
- **链上仲裁**：付款方 `dispute()` 冻结托管，仲裁人 `resolve()` 裁决归谁
- **一次付款一次请求**：challenge + EIP-712 签名，换 prompt / 换客户端 / 重放全部失效
- **零沉淀**：结算后合约余额恒为 0，没有可攻击的资金池
- **真实推理**：网关接任意 OpenAI 兼容接口，计费逻辑与模型无关

## 快速开始（本地，无需真实资产）

```bash
cd agentpay
npm install
npm run certs          # 生成本地 TLS/mTLS 证书
npx hardhat test       # 59 passing

# 终端 A
npx hardhat node
# 终端 B
npx hardhat run scripts/deploy.js --network localhost
npx hardhat run scripts/register-service.js --network localhost
node demo/server.js
# 终端 C：官网 + 全流程演示
cd ../agentpay-site && node serve.js
# 打开 http://127.0.0.1:4023/demo.html 点“单次付费流程”
```

详细文档见 [`agentpay/README.md`](agentpay/README.md) 与 [`agentpay-site/README.md`](agentpay-site/README.md)。

## 部署上主网（发币）

```bash
cd agentpay
cp .env.example .env   # 填 PRIVATE_KEY（专用钱包）与 BSCSCAN_API_KEY
npm run deploy:mainnet # gas 约 150 万单位，成本通常 $0.05–$0.30
# 照终端打印的 verify 命令在 BscScan 验证源码
```

然后：PancakeSwap 建池 + **锁 LP**。完整清单见 `agentpay/README.md` 的部署章节。

## 安全说明（务必阅读）

- `demo/` 与 `demo.html` 中出现的私钥全部是 **Hardhat 公开测试私钥**（源自 Hardhat 官方助记词），只对本地链有效，**绝不要**用于测试网/主网
- 合约**未经第三方审计**；上主网前请自行审计
- 网关 CORS 为 `*`（演示用），生产请收紧；`ADMIN_TOKEN` 必须设置
- 代币的经济价值取决于有没有人真的用它付费；发币本身不创造需求
- 面向中国大陆公众的代币发行融资有明确法律风险；境外也涉及证券认定、KYC/AML 与税务

## License

[MIT](LICENSE)
