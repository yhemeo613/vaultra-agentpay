// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentPay (AGP)
 * @notice BEP-20 代币，总量 10 亿枚，部署时一次性铸造给部署者。
 *
 * 刻意保留的「没有」：
 *   - 没有 mint()          => 永久固定总量，任何人无法增发
 *   - 没有 blacklist()     => 不存在单方面冻结某个地址的权限
 *   - 没有 _update 重写    => 零交易税，买/卖/转都一样
 *   - 没有 pause()         => 不存在整体停摆开关
 *
 * 这些「没有」本身就是信任资产：任何人都能在 BscScan 上验证。
 * 唯一的 owner 权限是 OZ Ownable 自带的 renounceOwnership()，可以不保留任何特权。
 */
contract AgentToken is ERC20, ERC20Burnable, Ownable {
    /// @notice 总量上限，链上可查
    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;

    constructor() ERC20("AgentPay", "AGP") Ownable(msg.sender) {
        _mint(msg.sender, MAX_SUPPLY);
    }
}
