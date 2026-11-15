// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title P2LiquidationFixture
 * @notice Fixture constants for Phase 2 flash-liquidation MVP on Arbitrum One.
 *
 * Provenance Header:
 * - Network: Arbitrum One (Chain ID 42161)
 * - Reference Liquidation Transaction (TX_L):
 *   0x7c3dd38d65c8c8a32ab1c32272223110b96ef6e72682bba1d7bf130d35bf3e4f
 *   Block L: 521512196, tx index: 9, status: 1
 * - Pinned Fork Block (L - 1): 521512195
 *   Block hash: 0xb490d839a67d4cb9bb47f14a213e37c60064316091cc1b3d72d328dddf83bd08
 *   Timestamp: 1793891659
 *   Base fee: 20048000 wei
 * - External Protocols & Contracts:
 *   - Aave V3 Pool: 0x794a61358D6845594F94dc1DB02A252b5b4814aD
 *   - Aave V3 PoolAddressesProvider: 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
 *   - Aave V3 Oracle: 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7
 *   - Uniswap SwapRouter02: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *     Source repo: https://github.com/Uniswap/swap-router-contracts
 *     Commit: 8fe4f086cee7c08f0bdb6ebe20c9ab615921c65f (tag v1.1.0)
 *     Docs: https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
 *   - Uniswap V3 Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984
 *   - WETH/USDC 0.05% Pool: 0xC6962004f452bE9203591991D15f6b388e09E8D0
 * - Tokens:
 *   - WETH: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 (18 decimals)
 *   - Native USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 (6 decimals)
 * - Liquidated Borrower: 0x25f5BA6623B40C52269B746D28215190833C2E39
 * - Liquidation Parameters:
 *   - debtToCover: 2702978093 (2,702.978093 USDC)
 *   - expectedSeizedWeth: 1239431252024708050 (≈1.239431 WETH)
 * - Oracle Prices (1e8 base currency):
 *   - WETH at L - 1: 228330000000 ($2,283.30)
 *   - WETH recorded in TX_L (injected in T1): 227867347285 ($2,278.67347285)
 *   - USDC at L - 1 and L: 99987503 ($0.99987503)
 * - Borrower Account Data at L - 1:
 *   - totalCollateralBase: 644361367319
 *   - totalDebtBase: 540528061766
 *   - currentLiquidationThreshold: 8400
 *   - ltv: 8100
 *   - healthFactor: 1001360681958966266 (> 1e18)
 * - Historical Execution Profile:
 *   - gasUsed: 1919392
 *   - effectiveGasPrice: 38129200 wei
 *   - gasUsedForL1: 0
 */
abstract contract P2LiquidationFixture {
    uint256 public constant CHAIN_ID = 42161;

    // Transaction & Block Identification
    bytes32 public constant TX_L = 0x7c3dd38d65c8c8a32ab1c32272223110b96ef6e72682bba1d7bf130d35bf3e4f;
    uint256 public constant BLOCK_L = 521512196;
    uint256 public constant FORK_BLOCK = 521512195; // L - 1
    bytes32 public constant FORK_BLOCK_HASH = 0xb490d839a67d4cb9bb47f14a213e37c60064316091cc1b3d72d328dddf83bd08;
    uint256 public constant FORK_BLOCK_TIMESTAMP = 1793891659;
    uint256 public constant FORK_BLOCK_BASE_FEE = 20048000;

    // Core Protocols
    address public constant POOL = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
    address public constant POOL_ADDRESSES_PROVIDER = 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb;
    address public constant ORACLE = 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7;
    address public constant SWAP_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address public constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address public constant WETH_USDC_POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0;
    uint24 public constant POOL_FEE = 500; // 0.05%

    // Assets & Decimals
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    uint8 public constant WETH_DECIMALS = 18;
    uint8 public constant USDC_DECIMALS = 6;

    // Target Borrower & Amounts
    address public constant BORROWER = 0x25f5BA6623B40C52269B746D28215190833C2E39;
    uint256 public constant DEBT_TO_COVER = 2702978093; // 2,702.978093 USDC
    uint256 public constant EXPECTED_SEIZED_WETH = 1239431252024708050; // Exact amount seized in TX_L

    // Oracle Prices (1e8 base currency)
    uint256 public constant WETH_PRICE_L_MINUS_1 = 228330000000;
    uint256 public constant WETH_PRICE_INJECTED = 227867347285; // Recorded price inside TX_L
    uint256 public constant USDC_PRICE = 99987503;

    // Borrower Expected Account Data at L - 1
    uint256 public constant EXPECTED_TOTAL_COLLATERAL_BASE = 644361367319;
    uint256 public constant EXPECTED_TOTAL_DEBT_BASE = 540528061766;
    uint256 public constant EXPECTED_LIQUIDATION_THRESHOLD = 8400;
    uint256 public constant EXPECTED_LTV = 8100;
    uint256 public constant EXPECTED_HEALTH_FACTOR_L_MINUS_1 = 1001360681958966266;

    // Protocol Constants
    uint256 public constant FLASHLOAN_PREMIUM_TOTAL = 5; // 5 bps = 0.05%
    uint256 public constant POOL_REVISION = 11;
    address public constant EXPECTED_PRICE_ORACLE_SENTINEL = address(0);

    // Cost Model Parameters (§6.5)
    uint256 public constant REAL_GAS_USED = 1919392;
    uint256 public constant REAL_EFFECTIVE_GAS_PRICE = 38129200; // wei
    uint256 public constant GAS_MARGIN_MULTIPLIER = 2;
}
