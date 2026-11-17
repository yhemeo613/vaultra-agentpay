const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const SERVICE_ID = ethers.id("infer-v1");
const PRICE = ethers.parseEther("1");
const MEMO = ethers.id("challenge-abc");

async function deployFixture() {
  const [deployer, provider, caller, treasury, stranger, arbiter] = await ethers.getSigners();

  const token = await ethers.deployContract("AgentToken");
  await token.waitForDeployment();

  // 全部供应量在部署者手里，给调用方分一点用来测试付款
  await token.transfer(caller.address, ethers.parseEther("1000"));

  const agentPay = await ethers.deployContract("AgentPay", [await token.getAddress(), treasury.address, arbiter.address]);
  await agentPay.waitForDeployment();

  await agentPay.connect(provider).setService(SERVICE_ID, PRICE, "https://api.example.com/v1/infer");

  return { token, agentPay, deployer, provider, caller, treasury, stranger, arbiter };
}

/** 付款并返回 gross/fee */
async function payOnce(fixture, calls = 1n, memo = MEMO) {
  const { token, agentPay, caller } = fixture;
  const gross = PRICE * calls;
  const fee = (gross * 50n) / 10_000n;
  await token.connect(caller).approve(await agentPay.getAddress(), gross);
  await agentPay.connect(caller).pay(SERVICE_ID, calls, memo);
  return { gross, fee, net: gross - fee };
}

describe("AgentToken", function () {
  it("部署时一次性铸出 10 亿枚给部署者", async function () {
    const { token, deployer } = await loadFixture(deployFixture);
    const supply = ethers.parseEther("1000000000");

    expect(await token.name()).to.equal("AgentPay");
    expect(await token.symbol()).to.equal("AGP");
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(supply);
    // fixture 里已从部署者转给调用方 1000 枚
    expect(await token.balanceOf(deployer.address)).to.equal(supply - ethers.parseEther("1000"));
  });

  it("不暴露 mint / blacklist / pause / setTax 等后门入口", async function () {
    const { token } = await loadFixture(deployFixture);
    for (const fn of ["mint", "blacklist", "setBlacklist", "pause", "setTax", "setFees"]) {
      expect(token.interface.getFunction(fn), `${fn} 不应该存在`).to.be.null;
    }
  });

  it("burn 会真实减少总量", async function () {
    const { token, deployer } = await loadFixture(deployFixture);
    const before = await token.totalSupply();
    await token.connect(deployer).burn(ethers.parseEther("1000"));
    expect(await token.totalSupply()).to.equal(before - ethers.parseEther("1000"));
  });
});

describe("AgentPay · 服务注册", function () {
  it("服务方可以注册服务", async function () {
    const { agentPay, provider } = await loadFixture(deployFixture);
    const service = await agentPay.services(SERVICE_ID);

    expect(service.provider).to.equal(provider.address);
    expect(service.price).to.equal(PRICE);
    expect(service.active).to.equal(true);
  });

  it("只有 provider 本人能下线服务", async function () {
    const { agentPay, stranger } = await loadFixture(deployFixture);
    await expect(agentPay.connect(stranger).closeService(SERVICE_ID))
      .to.be.revertedWithCustomError(agentPay, "NotProvider");
  });
});

describe("AgentPay · 托管与结算", function () {
  it("付款后资金停在合约里，服务方一分钱还没拿到", async function () {
    const { token, agentPay, caller, provider } = await loadFixture(deployFixture);

    const { gross } = await payOnce({ token, agentPay, caller }, 3n);
    const providerBefore = await token.balanceOf(provider.address);

    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(gross);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore);

    const escrow = await agentPay.escrows(MEMO);
    expect(escrow.payer).to.equal(caller.address);
    expect(escrow.amount).to.equal(gross);
    expect(escrow.state).to.equal(0n); // OPEN
  });

  it("provider 交付后 claim：拿到 99.5%，财库拿 0.5%，合约清零", async function () {
    const { token, agentPay, caller, provider, treasury } = await loadFixture(deployFixture);
    const { gross, fee, net } = await payOnce({ token, agentPay, caller }, 3n);

    const providerBefore = await token.balanceOf(provider.address);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await expect(agentPay.connect(provider).claim(MEMO))
      .to.emit(agentPay, "Claimed")
      .withArgs(MEMO, provider.address, net, fee);

    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + net);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(0n);
    // 调用方 fixture 起始 1000 AGP，付掉 gross 后剩 1000 - gross
    expect(await token.balanceOf(caller.address)).to.equal(ethers.parseEther("1000") - gross);
  });

  it("不是该服务的 provider 就不能 claim", async function () {
    const { token, agentPay, caller, stranger } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await expect(agentPay.connect(stranger).claim(MEMO))
      .to.be.revertedWithCustomError(agentPay, "NotProvider");
  });

  it("不能重复 claim", async function () {
    const { token, agentPay, caller, provider } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await agentPay.connect(provider).claim(MEMO);
    await expect(agentPay.connect(provider).claim(MEMO))
      .to.be.revertedWithCustomError(agentPay, "BadState");
  });

  it("同一个 memo 不能重复付款（否则托管会被覆盖）", async function () {
    const { token, agentPay, caller } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await token.connect(caller).approve(await agentPay.getAddress(), PRICE);
    await expect(agentPay.connect(caller).pay(SERVICE_ID, 1, MEMO))
      .to.be.revertedWithCustomError(agentPay, "DuplicateMemo");
  });

  it("memo 为 0 直接拒绝", async function () {
    const { token, agentPay, caller } = await loadFixture(deployFixture);
    await token.connect(caller).approve(await agentPay.getAddress(), PRICE);

    await expect(agentPay.connect(caller).pay(SERVICE_ID, 1, ethers.ZeroHash))
      .to.be.revertedWithCustomError(agentPay, "BadArgs");
  });

  it("授权额度不足时付款失败", async function () {
    const { agentPay, caller } = await loadFixture(deployFixture);
    await expect(agentPay.connect(caller).pay(SERVICE_ID, 1, MEMO))
      .to.be.revertedWithCustomError(agentPay, "InsufficientAllowance");
  });

  it("服务下线后无法付款", async function () {
    const { token, agentPay, provider, caller } = await loadFixture(deployFixture);
    await agentPay.connect(provider).closeService(SERVICE_ID);
    await token.connect(caller).approve(await agentPay.getAddress(), PRICE);

    await expect(agentPay.connect(caller).pay(SERVICE_ID, 1, MEMO))
      .to.be.revertedWithCustomError(agentPay, "ServiceInactive");
  });
});

describe("AgentPay · 超时退款", function () {
  it("没到退款窗口前不能退", async function () {
    const { token, agentPay, caller } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await expect(agentPay.connect(caller).refund(MEMO))
      .to.be.revertedWithCustomError(agentPay, "TooEarly");
  });

  it("超过 refundDelay 后付款方可以原额退回", async function () {
    const { token, agentPay, caller } = await loadFixture(deployFixture);
    const { gross } = await payOnce({ token, agentPay, caller }, 2n);

    const before = await token.balanceOf(caller.address);
    await time.increase(24 * 60 * 60 + 1);

    await expect(agentPay.connect(caller).refund(MEMO))
      .to.emit(agentPay, "Refunded")
      .withArgs(MEMO, caller.address, gross);

    expect(await token.balanceOf(caller.address)).to.equal(before + gross);
    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(0n);
  });

  it("别人不能替付款方退款", async function () {
    const { token, agentPay, caller, stranger } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });
    await time.increase(24 * 60 * 60 + 1);

    await expect(agentPay.connect(stranger).refund(MEMO))
      .to.be.revertedWithCustomError(agentPay, "NotPayer");
  });

  it("已经 claim 过的就不能再退", async function () {
    const { token, agentPay, caller, provider } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await agentPay.connect(provider).claim(MEMO);
    await time.increase(24 * 60 * 60 + 1);

    await expect(agentPay.connect(caller).refund(MEMO))
      .to.be.revertedWithCustomError(agentPay, "BadState");
  });

  it("refundDelay 有上下限", async function () {
    const { agentPay } = await loadFixture(deployFixture);

    await expect(agentPay.setRefundDelay(60)).to.be.revertedWithCustomError(agentPay, "BadRefundDelay");
    await expect(agentPay.setRefundDelay(31 * 24 * 60 * 60)).to.be.revertedWithCustomError(agentPay, "BadRefundDelay");

    await agentPay.setRefundDelay(2 * 24 * 60 * 60);
    expect(await agentPay.refundDelay()).to.equal(2n * 24n * 60n * 60n);
  });
});

describe("AgentPay · 仲裁", function () {
  it("付款方可以 dispute，托管进入冻结态", async function () {
    const { token, agentPay, caller } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await expect(agentPay.connect(caller).dispute(MEMO))
      .to.emit(agentPay, "Disputed")
      .withArgs(MEMO, caller.address);

    const escrow = await agentPay.escrows(MEMO);
    expect(escrow.state).to.equal(3n); // DISPUTED
  });

  it("dispute 后 claim 和 refund 都不可用", async function () {
    const { token, agentPay, caller, provider } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await agentPay.connect(caller).dispute(MEMO);

    await expect(agentPay.connect(provider).claim(MEMO))
      .to.be.revertedWithCustomError(agentPay, "BadState");

    await time.increase(24 * 60 * 60 + 1);
    await expect(agentPay.connect(caller).refund(MEMO))
      .to.be.revertedWithCustomError(agentPay, "BadState");
  });

  it("只有付款方能 dispute", async function () {
    const { token, agentPay, caller, stranger } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await expect(agentPay.connect(stranger).dispute(MEMO))
      .to.be.revertedWithCustomError(agentPay, "NotPayer");
  });

  it("只有仲裁人能 resolve，且只在 DISPUTED 态", async function () {
    const { token, agentPay, caller, stranger, arbiter } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    // 未 dispute 时不能 resolve
    await expect(agentPay.connect(arbiter).resolve(MEMO, true))
      .to.be.revertedWithCustomError(agentPay, "BadState");

    await agentPay.connect(caller).dispute(MEMO);

    // 非仲裁人不能 resolve
    await expect(agentPay.connect(stranger).resolve(MEMO, true))
      .to.be.revertedWithCustomError(agentPay, "NotArbiter");
  });

  it("仲裁判服务方胜：按 claim 分配（net 给 provider，fee 给财库）", async function () {
    const { token, agentPay, caller, provider, treasury, arbiter } = await loadFixture(deployFixture);
    const { gross, fee, net } = await payOnce({ token, agentPay, caller }, 3n);

    await agentPay.connect(caller).dispute(MEMO);

    const providerBefore = await token.balanceOf(provider.address);
    const treasuryBefore = await token.balanceOf(treasury.address);

    await expect(agentPay.connect(arbiter).resolve(MEMO, true))
      .to.emit(agentPay, "Resolved")
      .withArgs(MEMO, arbiter.address, true, gross);

    expect(await token.balanceOf(provider.address)).to.equal(providerBefore + net);
    expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore + fee);
    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(0n);

    const escrow = await agentPay.escrows(MEMO);
    expect(escrow.state).to.equal(4n); // RESOLVED
  });

  it("仲裁判付款方胜：原额退回，不再扣费", async function () {
    const { token, agentPay, caller, provider, arbiter } = await loadFixture(deployFixture);
    const { gross } = await payOnce({ token, agentPay, caller }, 3n);

    await agentPay.connect(caller).dispute(MEMO);

    const providerBefore = await token.balanceOf(provider.address);
    const callerBefore = await token.balanceOf(caller.address);

    await expect(agentPay.connect(arbiter).resolve(MEMO, false))
      .to.emit(agentPay, "Resolved")
      .withArgs(MEMO, arbiter.address, false, gross);

    expect(await token.balanceOf(caller.address)).to.equal(callerBefore + gross);
    expect(await token.balanceOf(provider.address)).to.equal(providerBefore); // 服务方一分没拿
    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(0n);
  });

  it("resolve 只能执行一次", async function () {
    const { token, agentPay, caller, arbiter } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    await agentPay.connect(caller).dispute(MEMO);
    await agentPay.connect(arbiter).resolve(MEMO, false);

    await expect(agentPay.connect(arbiter).resolve(MEMO, false))
      .to.be.revertedWithCustomError(agentPay, "BadState");
  });

  it("owner 可以换仲裁人", async function () {
    const { agentPay, deployer, arbiter } = await loadFixture(deployFixture);
    await agentPay.connect(deployer).setArbiter(arbiter.address);
    expect(await agentPay.arbiter()).to.equal(arbiter.address);
  });
});

describe("AgentPay · 管理权限", function () {
  it("费率硬上限 5%，且只有 owner 能改", async function () {
    const { agentPay, deployer, stranger } = await loadFixture(deployFixture);

    await expect(agentPay.connect(deployer).setFee(501))
      .to.be.revertedWithCustomError(agentPay, "FeeTooHigh");

    await expect(agentPay.connect(stranger).setFee(100))
      .to.be.revertedWithCustomError(agentPay, "OwnableUnauthorizedAccount");

    await agentPay.connect(deployer).setFee(100);
    expect(await agentPay.feeBps()).to.equal(100n);
  });

  it("owner 也动不了别人已经托管的钱", async function () {
    const { token, agentPay, caller, deployer } = await loadFixture(deployFixture);
    await payOnce({ token, agentPay, caller });

    // 没有提供任何「owner 提款」入口，合约余额只能由 claim / refund 流出
    expect(agentPay.interface.getFunction("withdraw")).to.be.null;
    expect(await token.balanceOf(await agentPay.getAddress())).to.equal(PRICE);
    expect(deployer.address).to.not.equal(caller.address);
  });
});
