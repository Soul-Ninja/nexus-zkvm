// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {TwoPoolArb} from "../../src/TwoPoolArb.sol";
import {IERC20} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {P3ArbFixture} from "../fixtures/P3ArbFixture.sol";

/// @title P4CrossCheck
/// @notice Independent Foundry cross-check of Phase 4 I1 decision simulation
/// @dev Pinned fork at block 521208669 per spec §7
contract P4CrossCheck is Test, P3ArbFixture {
    uint256 public constant FORK_BLOCK_P4 = 521208669;

    // Values copied from pipeline I1 decision run on block 521208669:
    // Trade size: 10,000 USDC raw (10000000000)
    // Simulated raw profit: 59503988 (59.503988 USDC)
    uint256 public constant I1_SIZE = 10000000000;
    uint256 public constant I1_EXPECTED_PROFIT = 59503988;

    TwoPoolArb internal arbContract;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"), FORK_BLOCK_P4);
        arbContract = new TwoPoolArb();
        deal(USDC, address(arbContract), 20_000e6);
    }

    /// @notice Cross-check: executes the exact same trade size on a fresh TwoPoolArb instance
    /// and asserts that the realized profit matches I1's sim_profit_raw exactly.
    function testFork_P4_CrossCheck() public {
        uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));

        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, I1_SIZE, 0);

        uint256 balAfter = IERC20(USDC).balanceOf(address(arbContract));
        uint256 profit = balAfter - balBefore;

        console.log("=== P4 Foundry Cross-Check ===");
        console.log("Block:", block.number);
        console.log("Trade Size USDC:", I1_SIZE);
        console.log("Foundry Measured Profit:", profit);
        console.log("I1 sim_profit_raw:", I1_EXPECTED_PROFIT);

        assertEq(profit, I1_EXPECTED_PROFIT, "Foundry cross-check profit must match I1 sim_profit_raw exactly");
        assertEq(IERC20(WETH).balanceOf(address(arbContract)), 0, "WETH balance must be 0");
    }
}
