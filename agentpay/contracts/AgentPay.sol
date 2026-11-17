// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/**
 * @title AgentPay
 * @notice AI Agent 的按次计费结算层 —— 托管 + 仲裁版本。
 *
 * 托管生命周期：
 *   pay()      付款方把钱转进合约托管，记一条 escrow（key = memo）
 *   claim()    服务方交付成功后结算（state OPEN -> CLAIMED）
 *   refund()   超过 refundDelay 未结算，付款方原额退回（OPEN -> REFUNDED）
 *   dispute()  付款方在结算前发起争议（OPEN -> DISPUTED），托管冻结
 *   resolve()  仲裁人裁决：判给服务方或判给付款方（DISPUTED -> RESOLVED）
 *
 * 仲裁人是部署时指定的独立地址（建议多签），owner 无权干预任何一笔托管。
 * 一旦进入 DISPUTED，claim / refund 都不可用，只有仲裁人能解锁。
 */
contract AgentPay is Ownable {
    IERC20Min public immutable token;
    address public treasury;
    address public arbiter;

    /// @notice 平台费率，单位 bps（50 = 0.5%）
    uint16 public feeBps = 50;
    uint16 public constant MAX_FEE_BPS = 500;

    /// @notice 付款后多久仍未结算，付款方可以退款
    uint64 public refundDelay = 1 days;
    uint64 public constant MIN_REFUND_DELAY = 1 hours;
    uint64 public constant MAX_REFUND_DELAY = 30 days;

    enum EscrowState { OPEN, CLAIMED, REFUNDED, DISPUTED, RESOLVED }

    struct Service {
        address provider;
        uint96 price; // 单次调用价格，18 位小数
        string endpoint;
        bool active;
    }

    struct Escrow {
        address payer;
        bytes32 serviceId;
        uint96 amount;
        uint96 fee;
        uint64 expiresAt;
        EscrowState state;
    }

    mapping(bytes32 => Service) public services;
    /// @dev memo(通常就是 challengeId) => 托管记录
    mapping(bytes32 => Escrow) public escrows;

    event ServiceSet(bytes32 indexed id, address indexed provider, uint96 price, string endpoint);
    event ServiceClosed(bytes32 indexed id);
    event Paid(bytes32 indexed id, address indexed payer, uint256 gross, uint256 fee, bytes32 memo);
    event Claimed(bytes32 indexed memo, address indexed provider, uint256 net, uint256 fee);
    event Refunded(bytes32 indexed memo, address indexed payer, uint256 amount);
    event Disputed(bytes32 indexed memo, address indexed payer);
    event Resolved(bytes32 indexed memo, address indexed arbiter, bool toProvider, uint256 amount);

    error ZeroAddress();
    error BadArgs();
    error NotProvider();
    error NotPayer();
    error NotArbiter();
    error ServiceInactive();
    error FeeTooHigh();
    error InsufficientAllowance();
    error AmountTooLarge();
    error DuplicateMemo();
    error UnknownEscrow();
    error BadState(EscrowState expected, EscrowState actual);
    error TooEarly();
    error BadRefundDelay();

    constructor(IERC20Min _token, address _treasury, address _arbiter) Ownable(msg.sender) {
        if (address(_token) == address(0) || _treasury == address(0) || _arbiter == address(0)) {
            revert ZeroAddress();
        }
        token = _token;
        treasury = _treasury;
        arbiter = _arbiter;
    }

    // ---------------------------------------------------------------- admin

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
    }

    function setArbiter(address a) external onlyOwner {
        if (a == address(0)) revert ZeroAddress();
        arbiter = a;
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
    }

    function setRefundDelay(uint64 delay) external onlyOwner {
        if (delay < MIN_REFUND_DELAY || delay > MAX_REFUND_DELAY) revert BadRefundDelay();
        refundDelay = delay;
    }

    // ------------------------------------------------------------- services

    function setService(bytes32 id, uint96 price, string calldata endpoint) external {
        if (price == 0 || bytes(endpoint).length == 0) revert BadArgs();
        services[id] = Service(msg.sender, price, endpoint, true);
        emit ServiceSet(id, msg.sender, price, endpoint);
    }

    function closeService(bytes32 id) external {
        Service storage s = services[id];
        if (s.provider != msg.sender) revert NotProvider();
        s.active = false;
        emit ServiceClosed(id);
    }

    // --------------------------------------------------------------- billing

    /// @notice 为 calls 次调用预付费用，资金进入托管
    /// @param memo 调用方自定义的 32 字节标识（SDK 放 challengeId），同时是托管记录的 key
    function pay(bytes32 id, uint256 calls, bytes32 memo) external {
        Service storage s = services[id];
        if (!s.active || calls == 0) revert ServiceInactive();
        if (memo == bytes32(0)) revert BadArgs();
        if (escrows[memo].payer != address(0)) revert DuplicateMemo();

        uint256 gross = uint256(s.price) * calls;
        if (gross > type(uint96).max) revert AmountTooLarge();

        uint256 fee = (gross * feeBps) / 10_000;

        if (token.allowance(msg.sender, address(this)) < gross) revert InsufficientAllowance();
        if (!token.transferFrom(msg.sender, address(this), gross)) revert BadArgs();

        escrows[memo] = Escrow({
            payer: msg.sender,
            serviceId: id,
            amount: uint96(gross),
            fee: uint96(fee),
            expiresAt: uint64(block.timestamp) + refundDelay,
            state: EscrowState.OPEN
        });

        emit Paid(id, msg.sender, gross, fee, memo);
    }

    /// @notice 服务方交付成功后结算：拿走 net，fee 进财库
    function claim(bytes32 memo) external {
        Escrow storage e = escrows[memo];
        if (e.payer == address(0)) revert UnknownEscrow();
        if (e.state != EscrowState.OPEN) revert BadState(EscrowState.OPEN, e.state);

        Service storage s = services[e.serviceId];
        if (s.provider != msg.sender) revert NotProvider();

        e.state = EscrowState.CLAIMED;
        uint256 net = uint256(e.amount) - uint256(e.fee);
        if (net > 0 && !token.transfer(s.provider, net)) revert BadArgs();
        if (e.fee > 0 && !token.transfer(treasury, e.fee)) revert BadArgs();

        emit Claimed(memo, s.provider, net, e.fee);
    }

    /// @notice 超时未结算，付款方原额取回
    function refund(bytes32 memo) external {
        Escrow storage e = escrows[memo];
        if (e.payer == address(0)) revert UnknownEscrow();
        if (e.state != EscrowState.OPEN) revert BadState(EscrowState.OPEN, e.state);
        if (msg.sender != e.payer) revert NotPayer();
        if (block.timestamp < e.expiresAt) revert TooEarly();

        e.state = EscrowState.REFUNDED;
        if (!token.transfer(e.payer, e.amount)) revert BadArgs();

        emit Refunded(memo, e.payer, e.amount);
    }

    /// @notice 付款方在结算前发起争议，托管冻结
    function dispute(bytes32 memo) external {
        Escrow storage e = escrows[memo];
        if (e.payer == address(0)) revert UnknownEscrow();
        if (e.state != EscrowState.OPEN) revert BadState(EscrowState.OPEN, e.state);
        if (msg.sender != e.payer) revert NotPayer();

        e.state = EscrowState.DISPUTED;
        emit Disputed(memo, e.payer);
    }

    /// @notice 仲裁人裁决：判给服务方或判给付款方
    /// @param memo    托管 key
    /// @param toProvider true=服务方胜（按 claim 分配）；false=付款方胜（原额退回）
    function resolve(bytes32 memo, bool toProvider) external {
        Escrow storage e = escrows[memo];
        if (e.payer == address(0)) revert UnknownEscrow();
        if (e.state != EscrowState.DISPUTED) revert BadState(EscrowState.DISPUTED, e.state);
        if (msg.sender != arbiter) revert NotArbiter();

        e.state = EscrowState.RESOLVED;

        uint256 paidOut;
        if (toProvider) {
            Service storage s = services[e.serviceId];
            uint256 net = uint256(e.amount) - uint256(e.fee);
            if (net > 0 && !token.transfer(s.provider, net)) revert BadArgs();
            if (e.fee > 0 && !token.transfer(treasury, e.fee)) revert BadArgs();
            paidOut = e.amount;
        } else {
            if (!token.transfer(e.payer, e.amount)) revert BadArgs();
            paidOut = e.amount;
        }

        emit Resolved(memo, arbiter, toProvider, paidOut);
    }
}
