// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title AaveV3ArbitrumFixture
 * @notice Fixture constants for Aave V3 Arbitrum One fork testing.
 *
 * Provenance Header:
 * - Network: Arbitrum One (Chain ID 42161)
 * - Source repository for addresses: https://github.com/bgd-labs/aave-address-book
 * - Address-book commit SHA: b8c801a413c4b934afaf7976d2ddc5fbada6dce6
 * - Address-book source file: src/AaveV3Arbitrum.sol
 * - Capture Date: 2026-11-15
 *
 * Captured Cast Commands (RPC URL redacted as $ARBITRUM_RPC_URL):
 * - Block numbers:
 *   cast block latest --rpc-url "$ARBITRUM_RPC_URL" --field number -> 524382336
 *   cast block finalized --rpc-url "$ARBITRUM_RPC_URL" --field number -> 524378426
 * - FORK_BLOCK capture:
 *   cast block 521878426 --rpc-url "$ARBITRUM_RPC_URL" --field hash
 *     -> 0x5d981c96a8f0c0efbc4c97441f0581f01ee2db3dbe6f2b5db6cd6e0f3cc49dee
 *   cast block 521878426 --rpc-url "$ARBITRUM_RPC_URL" --field timestamp
 *     -> 1793992460
 * - Source Borrow log query:
 *   cast logs --address 0x794a61358D6845594F94dc1DB02A252b5b4814aD --from-block 521878000 --to-block 521878426 "Borrow(address,address,address,uint256,uint8,uint256,uint16)"
 *     -> Log at block 521878404, tx 0xf81c9b7ac3dc641f433a980558350c4a9039ec480ddffc9bb1890c05baf35fc7, onBehalfOf = 0xAf18232ba591ba9eB8Ef179B3869565A50B56790
 * - Borrower Account Data at FORK_BLOCK (521878426):
 *   cast call 0x794a61358D6845594F94dc1DB02A252b5b4814aD "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" 0xAf18232ba591ba9eB8Ef179B3869565A50B56790 --block 521878426 --rpc-url "$ARBITRUM_RPC_URL"
 *     -> totalCollateralBase = 222685005
 *     -> totalDebtBase = 99987830
 *     -> availableBorrowsBase = 80387024
 *     -> currentLiquidationThreshold = 8400
 *     -> ltv = 8100
 *     -> healthFactor = 1870781716134853611
 * - Oracle / Provider queries at FORK_BLOCK (521878426):
 *   cast call 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7 "BASE_CURRENCY()(address)" --block 521878426 --rpc-url "$ARBITRUM_RPC_URL"
 *     -> 0x0000000000000000000000000000000000000000
 *   cast call 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7 "BASE_CURRENCY_UNIT()(uint256)" --block 521878426 --rpc-url "$ARBITRUM_RPC_URL"
 *     -> 100000000
 * - LiquidationCall log query (D-006):
 *   cast logs --address 0x794a61358D6845594F94dc1DB02A252b5b4814aD --from-block 521700000 --to-block 521850000 "LiquidationCall(address,address,address,uint256,uint256,address,bool)"
 *     -> Block L = 521749898, tx 0xce2f84a8c6dc2ff01f81832757edcd13f9fb108c7cc60ed8fd8a84ea19278524, user = 0x452Ec9e1CD041843034Fa1A5E61E0496253F174b
 *   cast receipt 0xce2f84a8c6dc2ff01f81832757edcd13f9fb108c7cc60ed8fd8a84ea19278524 status --rpc-url "$ARBITRUM_RPC_URL"
 *     -> true
 *   cast call 0x794a61358D6845594F94dc1DB02A252b5b4814aD "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" 0x452Ec9e1CD041843034Fa1A5E61E0496253F174b --block 521749897 --rpc-url "$ARBITRUM_RPC_URL"
 *     -> totalCollateralBase = 100636136
 *     -> totalDebtBase = 78496785
 *     -> availableBorrowsBase = 0
 *     -> currentLiquidationThreshold = 7800
 *     -> ltv = 0
 *     -> healthFactor = 999992370133375526
 */
abstract contract AaveV3ArbitrumFixture {
    uint256 public constant CHAIN_ID = 42161;

    address public constant POOL_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address public constant POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant ORACLE = 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7;

    uint256 public constant FORK_BLOCK = 521878426;
    bytes32 public constant FORK_BLOCK_HASH = 0x5d981c96a8f0c0efbc4c97441f0581f01ee2db3dbe6f2b5db6cd6e0f3cc49dee;
    uint256 public constant FORK_BLOCK_TIMESTAMP = 1793992460;

    address public constant BORROWER = 0xAF18232Ba591Ba9EB8ef179B3869565A50b56790;
    bytes32 public constant BORROW_TX = 0xf81c9b7ac3dc641f433a980558350c4a9039ec480ddffc9bb1890c05baf35fc7;
    uint256 public constant BORROW_BLOCK = 521878404;

    uint256 public constant EXPECTED_TOTAL_COLLATERAL_BASE = 222685005;
    uint256 public constant EXPECTED_TOTAL_DEBT_BASE = 99987830;
    uint256 public constant EXPECTED_AVAILABLE_BORROWS_BASE = 80387024;
    uint256 public constant EXPECTED_CURRENT_LIQUIDATION_THRESHOLD = 8400;
    uint256 public constant EXPECTED_LTV = 8100;
    uint256 public constant EXPECTED_HEALTH_FACTOR = 1870781716134853611;

    address public constant EXPECTED_BASE_CURRENCY = address(0);
    uint256 public constant EXPECTED_BASE_CURRENCY_UNIT = 100000000; // 1e8

    uint256 public constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18;

    // D-006: Conditional liquidatable borrower fixture
    uint256 public constant LIQ_BLOCK_L = 521749898;
    uint256 public constant LIQ_FORK_BLOCK = 521749897; // L - 1
    bytes32 public constant LIQ_FORK_BLOCK_HASH = 0xd4af67b69f3b0ed890ad26e5d87ec5e8741a6dbeef019eb1fb99e4ac310cd9e8;
    uint256 public constant LIQ_FORK_BLOCK_TIMESTAMP = 1793957474;
    bytes32 public constant LIQ_TX_L = 0xce2f84a8c6dc2ff01f81832757edcd13f9fb108c7cc60ed8fd8a84ea19278524;
    address public constant LIQ_BORROWER = 0x452EC9E1cD041843034Fa1a5e61e0496253f174B;

    uint256 public constant LIQ_EXPECTED_TOTAL_COLLATERAL_BASE = 100636136;
    uint256 public constant LIQ_EXPECTED_TOTAL_DEBT_BASE = 78496785;
    uint256 public constant LIQ_EXPECTED_AVAILABLE_BORROWS_BASE = 0;
    uint256 public constant LIQ_EXPECTED_CURRENT_LIQUIDATION_THRESHOLD = 7800;
    uint256 public constant LIQ_EXPECTED_LTV = 0;
    uint256 public constant LIQ_EXPECTED_HEALTH_FACTOR = 999992370133375526;
}
