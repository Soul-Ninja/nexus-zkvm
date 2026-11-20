// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {TwoPoolArb} from "../../src/TwoPoolArb.sol";
import {
    IUniswapV3PoolMinimal,
    IERC20,
    IUniswapV3Factory,
    IAaveOracle
} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {P3ArbFixture} from "../fixtures/P3ArbFixture.sol";

/// @title TwoPoolArbForkTest
/// @notice Pinned Arbitrum One fork test suite for TwoPoolArb
/// @dev Implements T0-T8 and F1 per docs/specs/phase-3.md §7 and §7a amendment
contract TwoPoolArbForkTest is Test, P3ArbFixture {
    TwoPoolArb internal arbContract;
    uint256 internal forkTx;
    uint256 internal forkLMinus1;
    bool internal forkTxCreated;
    bool internal forkLMinus1Created;

    function setUp() public {
        // Default environment setup; specific forks selected in test helpers
    }

    function _initLMinus1() internal {
        if (!forkLMinus1Created) {
            forkLMinus1 = vm.createFork(vm.rpcUrl("arbitrum"), FORK_BLOCK_L_MINUS_1);
            forkLMinus1Created = true;
        }
        vm.selectFork(forkLMinus1);
        arbContract = new TwoPoolArb();
        deal(USDC, address(arbContract), 10_000e6);
    }

    function _initTx() internal {
        if (!forkTxCreated) {
            forkTx = vm.createFork(vm.rpcUrl("arbitrum"), TX_A);
            forkTxCreated = true;
        }
        vm.selectFork(forkTx);
        arbContract = new TwoPoolArb();
        deal(USDC, address(arbContract), 35_000e6);
    }

    // =========================================================================
    // §7 Test Suite
    // =========================================================================

    /// @notice T0: Provenance checks on block L-1
    function testFork_T0_Provenance() public {
        _initLMinus1();

        assertEq(block.chainid, CHAIN_ID, "Chain ID mismatch");

        // Verify block L-1 header hash dynamically via RPC
        string memory json = vm.rpcJson("eth_getBlockByNumber", "[\"0x1f110360\", false]");
        bytes32 realHash = vm.parseJsonBytes32(json, ".hash");
        assertEq(realHash, BLOCK_L_MINUS_1_HASH, "Block L-1 hash mismatch");

        // Verify Sushi pool identity
        assertEq(IUniswapV3PoolMinimal(SUSHI_POOL).factory(), SUSHI_FACTORY, "Sushi factory mismatch");
        assertEq(IUniswapV3PoolMinimal(SUSHI_POOL).fee(), POOL_FEE, "Sushi fee mismatch");
        assertEq(IUniswapV3PoolMinimal(SUSHI_POOL).token0(), WETH, "Sushi token0 mismatch");
        assertEq(IUniswapV3PoolMinimal(SUSHI_POOL).token1(), USDC, "Sushi token1 mismatch");

        // Verify Uniswap pool identity
        assertEq(IUniswapV3PoolMinimal(UNI_POOL).factory(), UNI_FACTORY, "Uni factory mismatch");
        assertEq(IUniswapV3PoolMinimal(UNI_POOL).fee(), POOL_FEE, "Uni fee mismatch");
        assertEq(IUniswapV3PoolMinimal(UNI_POOL).token0(), WETH, "Uni token0 mismatch");
        assertEq(IUniswapV3PoolMinimal(UNI_POOL).token1(), USDC, "Uni token1 mismatch");

        console.log("=== T0: Fork Provenance ===");
        console.log("Chain ID:", block.chainid);
        console.log("Block L-1 header hash:");
        console.logBytes32(realHash);
    }

    /// @notice T1: Exact replay of historical arbitrage TX_A
    /// @dev Amended §7a: buy leg is exact input (AMOUNT_IN = 9381101055 USDC)
    function testFork_T1_ExactReplay() public {
        _initTx();

        (uint160 sushiP0,,,,,,) = IUniswapV3PoolMinimal(SUSHI_POOL).slot0();
        (uint160 uniP0,,,,,,) = IUniswapV3PoolMinimal(UNI_POOL).slot0();
        console.log("=== Pool prices just before swap in fork ===");
        console.log("Sushi p0:", sushiP0);
        console.log("Uni p0:", uniP0);

        vm.recordLogs();
        uint256 gasBefore = gasleft();
        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, AMOUNT_IN, 0);
        uint256 gasUsedMeasured = gasBefore - gasleft();

        // Find Arbitraged event in recorded logs
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 arbEventSig = keccak256("Arbitraged(address,address,uint256,uint256,uint256,uint256)");
        uint256 loggedAmountIn;
        uint256 loggedMidOut;
        uint256 loggedReceivedOut;
        uint256 loggedProfit;
        bool foundEvent = false;

        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == arbEventSig) {
                (loggedAmountIn, loggedMidOut, loggedReceivedOut, loggedProfit) =
                    abi.decode(entries[i].data, (uint256, uint256, uint256, uint256));
                foundEvent = true;
                break;
            }
        }
        assertTrue(foundEvent, "Arbitraged event not emitted");

        // Exact numerical assertions from spec §3 and §7a
        assertEq(loggedAmountIn, AMOUNT_IN, "USDC paid to Sushi mismatch");
        assertEq(loggedMidOut, EXPECTED_MID_OUT, "WETH from Sushi mismatch");
        assertEq(loggedReceivedOut, EXPECTED_RECEIVED_OUT, "USDC from Uni mismatch");
        assertEq(loggedProfit, EXPECTED_PROFIT, "Profit mismatch");

        (uint160 sushiSqrtPriceAfter,,,,,,) = IUniswapV3PoolMinimal(SUSHI_POOL).slot0();
        (uint160 uniSqrtPriceAfter,,,,,,) = IUniswapV3PoolMinimal(UNI_POOL).slot0();

        console.log("=== T1: Exact Replay Logged Numbers ===");
        console.log("USDC paid to Sushi:", loggedAmountIn);
        console.log("WETH received from Sushi:", loggedMidOut);
        console.log("USDC received from Uni:", loggedReceivedOut);
        console.log("Realized profit USDC:", loggedProfit);
        console.log("Sushi sqrtPriceX96 after:", sushiSqrtPriceAfter);
        console.log("Expected Sushi sqrtPrice:", EXPECTED_SUSHI_SQRT_PRICE_AFTER);
        console.log("Uni sqrtPriceX96 after:", uniSqrtPriceAfter);
        console.log("Expected Uni sqrtPrice:", EXPECTED_UNI_SQRT_PRICE_AFTER);
        console.log("Gas used measured:", gasUsedMeasured);

        _verifyCostModel(loggedProfit, gasUsedMeasured);

        assertEq(sushiSqrtPriceAfter, EXPECTED_SUSHI_SQRT_PRICE_AFTER, "Sushi sqrtPrice after mismatch");
        assertEq(uniSqrtPriceAfter, EXPECTED_UNI_SQRT_PRICE_AFTER, "Uni sqrtPrice after mismatch");
    }

    /// @notice T2: Losing replay at block L-1 reverts with InsufficientProfit(0, 0)
    function testFork_T2_LosingReplay() public {
        _initLMinus1();

        uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));

        vm.expectRevert(abi.encodeWithSelector(TwoPoolArb.InsufficientProfit.selector, 0, 0));
        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, AMOUNT_IN, 0);

        assertEq(IERC20(USDC).balanceOf(address(arbContract)), balBefore, "USDC balance must be unchanged");
        assertEq(IERC20(WETH).balanceOf(address(arbContract)), 0, "WETH balance must be 0");
    }

    /// @notice T3: Trade size sweep at 0.25x, 0.5x, 1x, 1.5x, 2x, 3x (funded for 3x)
    function testFork_T3_SizeSweep() public {
        _initTx();

        uint256[8] memory multipliersBps = [
            uint256(2500), // 0.25x
            uint256(5000), // 0.5x
            uint256(10000), // 1.0x
            uint256(15000), // 1.5x
            uint256(20000), // 2.0x
            uint256(30000), // 3.0x
            uint256(50000), // 5.0x
            uint256(80000) // 8.0x
        ];

        string[8] memory labels = ["0.25x", "0.50x", "1.00x", "1.50x", "2.00x", "3.00x", "5.00x", "8.00x"];

        bool size1xProfitable = false;
        bool atLeastOneReverted = false;
        uint256 maxProfit = 0;
        string memory bestSize = "";

        console.log("=== T3: Size Sweep Table ===");

        for (uint256 i = 0; i < multipliersBps.length; i++) {
            uint256 size = (AMOUNT_IN * multipliersBps[i]) / 10000;
            uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));
            uint256 snap = vm.snapshotState();

            try arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, size, 0) {
                uint256 balAfter = IERC20(USDC).balanceOf(address(arbContract));
                uint256 profit = balAfter > balBefore ? balAfter - balBefore : 0;
                console.log("Size:", labels[i], "Profit USDC:", profit);

                if (multipliersBps[i] == 10000 && profit > 0) {
                    size1xProfitable = true;
                }
                if (profit > maxProfit) {
                    maxProfit = profit;
                    bestSize = labels[i];
                }
            } catch {
                console.log("Size:", labels[i], "Status: REVERT");
                atLeastOneReverted = true;
            }

            vm.revertToState(snap);
        }

        assertTrue(size1xProfitable, "1x trade size must be profitable");
        assertTrue(atLeastOneReverted, "At least one trade size must revert");
        console.log("Best trade size:", bestSize);
        console.log("Max profit USDC:", maxProfit);
    }

    /// @notice T4: Revert when minProfit exceeds actual realized profit
    function testFork_T4_MinProfitRevert() public {
        _initTx();

        vm.expectRevert(
            abi.encodeWithSelector(TwoPoolArb.InsufficientProfit.selector, EXPECTED_PROFIT, EXPECTED_PROFIT + 1)
        );
        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, AMOUNT_IN, EXPECTED_PROFIT + 1);
    }

    /// @notice T5a: Non-owner arb call reverts Unauthorized
    function testFork_T5a_NonOwnerArbReverts() public {
        _initLMinus1();

        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(TwoPoolArb.Unauthorized.selector);
        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, AMOUNT_IN, 0);
    }

    /// @notice T5b: Attacker direct callback call reverts UnexpectedCaller
    function testFork_T5b_AttackerCallbackReverts() public {
        _initLMinus1();

        address attacker = makeAddr("attacker");
        uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));
        bytes memory data = abi.encode(WETH, USDC);

        vm.prank(attacker);
        vm.expectRevert(TwoPoolArb.UnexpectedCaller.selector);
        arbContract.uniswapV3SwapCallback(0, 1000e6, data);

        assertEq(IERC20(USDC).balanceOf(address(arbContract)), balBefore, "USDC balance must be unchanged");
    }

    /// @notice T5c: Legitimate pool address direct callback outside arb reverts UnexpectedCaller
    function testFork_T5c_PoolDirectCallbackReverts() public {
        _initLMinus1();

        uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));
        bytes memory data = abi.encode(WETH, USDC);

        vm.prank(UNI_POOL);
        vm.expectRevert(TwoPoolArb.UnexpectedCaller.selector);
        arbContract.uniswapV3SwapCallback(0, 1000e6, data);

        assertEq(IERC20(USDC).balanceOf(address(arbContract)), balBefore, "USDC balance must be unchanged");
    }

    /// @notice T6: Mismatched pool token pair reverts PoolTokenMismatch
    function testFork_T6_PoolTokenMismatch() public {
        _initLMinus1();

        address wethUsdtPool = IUniswapV3Factory(UNI_FACTORY).getPool(WETH, USDT, POOL_FEE);
        console.log("Uniswap WETH/USDT Pool used in T6:", wethUsdtPool);

        vm.expectRevert(TwoPoolArb.PoolTokenMismatch.selector);
        arbContract.arb(SUSHI_POOL, wethUsdtPool, USDC, WETH, AMOUNT_IN, 0);
    }

    /// @notice T7: Owner withdrawal transfers tokens; non-owner and zero address revert
    function testFork_T7_Withdraw() public {
        _initLMinus1();

        address nonOwner = makeAddr("nonOwner");
        vm.prank(nonOwner);
        vm.expectRevert(TwoPoolArb.Unauthorized.selector);
        arbContract.withdraw(USDC, nonOwner, 100e6);

        vm.expectRevert(TwoPoolArb.ZeroAddress.selector);
        arbContract.withdraw(USDC, address(0), 100e6);

        address recipient = makeAddr("recipient");
        arbContract.withdraw(USDC, recipient, 1000e6);

        assertEq(IERC20(USDC).balanceOf(recipient), 1000e6, "Recipient balance mismatch");
        assertEq(IERC20(USDC).balanceOf(address(arbContract)), 9000e6, "Contract balance mismatch");
    }

    /// @notice T8: Clean state verification after successful arbitrage
    function testFork_T8_CleanStateAfterArb() public {
        _initTx();

        arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, AMOUNT_IN, 0);

        assertEq(IERC20(WETH).balanceOf(address(arbContract)), 0, "WETH balance must be 0");

        // Verify storage slot 0 (expectedPool) is reset to 0
        bytes32 slot0Val = vm.load(address(arbContract), bytes32(0));
        assertEq(slot0Val, bytes32(0), "expectedPool storage slot 0 must be 0");

        // Verify allowances are zero
        assertEq(IERC20(USDC).allowance(address(arbContract), SUSHI_POOL), 0, "USDC allowance to Sushi != 0");
        assertEq(IERC20(USDC).allowance(address(arbContract), UNI_POOL), 0, "USDC allowance to Uni != 0");
        assertEq(IERC20(WETH).allowance(address(arbContract), SUSHI_POOL), 0, "WETH allowance to Sushi != 0");
        assertEq(IERC20(WETH).allowance(address(arbContract), UNI_POOL), 0, "WETH allowance to Uni != 0");
    }

    /// @notice F1: Fuzz test across trade size and minProfit parameters (32 runs)
    /// @dev Amended §7a: fuzz amountIn in [1e6, 10_000e6]
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_F1_Arbitrage(uint256 amountIn, uint256 minProfit) public {
        _initTx();

        amountIn = bound(amountIn, 1e6, 10_000e6);
        minProfit = bound(minProfit, 0, 1e8);

        uint256 balBefore = IERC20(USDC).balanceOf(address(arbContract));
        uint256 snap = vm.snapshotState();

        try arbContract.arb(SUSHI_POOL, UNI_POOL, USDC, WETH, amountIn, minProfit) {
            uint256 balAfter = IERC20(USDC).balanceOf(address(arbContract));
            assertGe(balAfter, balBefore + minProfit, "Profit must be >= minProfit");
            assertEq(IERC20(WETH).balanceOf(address(arbContract)), 0, "WETH balance must be 0");
            bytes32 slot0Val = vm.load(address(arbContract), bytes32(0));
            assertEq(slot0Val, bytes32(0), "expectedPool slot 0 must be 0");
        } catch {
            assertEq(IERC20(USDC).balanceOf(address(arbContract)), balBefore, "Balance changed on revert");
        }

        vm.revertToState(snap);
    }

    // =========================================================================
    // §6.6 Cost Model Verification Helper
    // =========================================================================

    function _verifyCostModel(uint256 profitUsdc, uint256 gasUsedMeasured) internal view {
        uint256 usdcPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(USDC);
        uint256 wethPrice = IAaveOracle(AAVE_ORACLE).getAssetPrice(WETH);

        uint256 profitBase = (profitUsdc * usdcPrice) / 1e6;

        uint256 maxGas = gasUsedMeasured > HISTORICAL_GAS_USED ? gasUsedMeasured : HISTORICAL_GAS_USED;
        uint256 gasCostWei = 2 * maxGas * HISTORICAL_EFFECTIVE_GAS_PRICE;
        uint256 gasCostBase = (gasCostWei * wethPrice) / 1e18;

        console.log("=== Cost Model Verification (Section 6.6) ===");
        console.log("USDC Oracle Price (1e8 USD):", usdcPrice);
        console.log("WETH Oracle Price (1e8 USD):", wethPrice);
        console.log("Profit Base (1e8 USD):", profitBase);
        console.log("Gas Benchmark max(measured, real):", maxGas);
        console.log("Gas Cost (wei, 2x margin):", gasCostWei);
        console.log("Gas Cost Base (1e8 USD):", gasCostBase);
        console.log("Net Profit Base (1e8 USD):", profitBase - gasCostBase);

        assertTrue(profitBase > gasCostBase, "Gate failed: profitBase <= gasCostBase");
    }
}
