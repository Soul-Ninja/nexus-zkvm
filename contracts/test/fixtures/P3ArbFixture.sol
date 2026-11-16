// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title P3ArbFixture
/// @notice Pinned constants, addresses, and expected historical values for Phase 3 arbitrage replay
/// @dev Provenance: Arbitrum One historical tx TX_A (block 521208673, tx index 134)
abstract contract P3ArbFixture {
    uint256 public constant CHAIN_ID = 42161;

    // Historical Arbitrage Transaction
    bytes32 public constant TX_A = 0x03222f2a1b0a213b75fc085ce7c23f65fc060a02a172ca2fc9c9df5f932b79c0;
    uint256 public constant FORK_BLOCK_L = 521208673;
    uint256 public constant FORK_BLOCK_L_MINUS_1 = 521208672;
    bytes32 public constant BLOCK_L_MINUS_1_HASH = 0x854cbfab2c0cadfef5b3c283d4630267de888bb4c8aafde861296f043081bda6;

    // Tokens
    address public constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address public constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    // Pools & Factories
    address public constant SUSHI_POOL = 0xf3Eb87C1F6020982173C908E7eB31aA66c1f0296;
    address public constant UNI_POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0;
    address public constant SUSHI_FACTORY = 0x1af415a1EbA07a4986a52B6f2e7dE7003D82231e;
    address public constant UNI_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    uint24 public constant POOL_FEE = 500; // 0.05%

    // Trade parameters and expected historical replay outcomes
    uint256 public constant AMOUNT_IN = 9381101055; // exact USDC spent on buy leg (Sushi)
    uint256 public constant MID_AMOUNT = 3898918598042384476; // exact WETH bought on Sushi, sold on Uni
    uint256 public constant EXPECTED_MID_OUT = 3898918598042384476; // exact WETH received from Sushi
    uint256 public constant EXPECTED_PAID_IN = 9381101055; // USDC paid to Sushi
    uint256 public constant EXPECTED_RECEIVED_OUT = 9435077811; // USDC received from Uni
    uint256 public constant EXPECTED_PROFIT = 53976756; // 53.976756 USDC

    uint160 public constant EXPECTED_SUSHI_SQRT_PRICE_AFTER = 3896270649601199303694517;
    uint160 public constant EXPECTED_UNI_SQRT_PRICE_AFTER = 3898315058101465043779590;

    // Historical gas benchmark parameters (§6.6)
    uint256 public constant HISTORICAL_GAS_USED = 574050;
    uint256 public constant HISTORICAL_EFFECTIVE_GAS_PRICE = 23326000; // wei

    // Aave Oracle for unmocked price reference in §6.6 cost model
    address public constant AAVE_ORACLE = 0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7;
}
