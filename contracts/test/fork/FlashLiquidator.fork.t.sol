// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";
import {FlashLiquidator} from "../../src/FlashLiquidator.sol";
import {
    IERC20,
    IPool,
    ISwapRouter02,
    IAaveOracle,
    IPoolAddressesProvider
} from "../../src/interfaces/IFlashLiquidatorDeps.sol";
import {P2LiquidationFixture} from "../fixtures/P2LiquidationFixture.sol";

contract FlashLiquidatorForkTest is Test, P2LiquidationFixture {
    FlashLiquidator internal liquidator;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"), FORK_BLOCK);
        liquidator = new FlashLiquidator(IPool(POOL), ISwapRouter02(SWAP_ROUTER_02));
    }

    /// @notice T0: Fork provenance (§7)
    function testFork_T0_Provenance() public {
        assertEq(block.chainid, CHAIN_ID, "block.chainid mismatch");

        // Dynamically fetch header hash from fork via JSON-RPC
        string memory blockJson = vm.rpcJson("eth_getBlockByNumber", "[\"0x1f15a503\", false]");
        bytes32 realHeaderHash = vm.parseJsonBytes32(blockJson, ".hash");
        assertEq(realHeaderHash, FORK_BLOCK_HASH, "FORK_BLOCK_HASH mismatch against real header hash");

        address sentinel = IPoolAddressesProvider(POOL_ADDRESSES_PROVIDER).getPriceOracleSentinel();
        assertEq(sentinel, EXPECTED_PRICE_ORACLE_SENTINEL, "PriceOracleSentinel mismatch");

        console.log("=== T0: Fork Provenance ===");
        console.log("Chain ID:", block.chainid);
        console.log("Fork block L-1 (L2):", FORK_BLOCK);
        console.log("Real Header Hash:");
        console.logBytes32(realHeaderHash);
        console.log("PriceOracleSentinel:", sentinel);
    }

    /// @notice T1: Profitable replay (§7)
    function testFork_T1_ProfitableReplay() public {
        // Mock only Aave ORACLE.getAssetPrice(WETH) -> 227867347285
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        // Assert USDC price is unmocked
        uint256 usdcPrice = IAaveOracle(ORACLE).getAssetPrice(USDC);
        assertEq(usdcPrice, USDC_PRICE, "USDC price must be unmocked");

        // Assert borrower HF < 1e18 after mock
        (,,,,, uint256 hf) = IPool(POOL).getUserAccountData(BORROWER);
        assertLt(hf, 1e18, "Borrower HF must be < 1e18");

        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "Initial liquidator USDC balance must be 0");

        vm.recordLogs();
        uint256 gasStart = gasleft();
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);
        uint256 gasUsedMeasured = gasStart - gasleft();

        // Extract logged values
        (uint256 loggedSeized, uint256 loggedSwapOut, uint256 loggedProfit) =
            _extractLiquidatedLog(vm.getRecordedLogs());

        console.log("=== T1: Profitable Replay Logged Numbers ===");
        console.log("Borrower HF before liq:", hf);
        console.log("Seized WETH (18 dec):", loggedSeized);
        console.log("Expected Seized WETH:", EXPECTED_SEIZED_WETH);
        console.log("Swap out USDC (6 dec):", loggedSwapOut);
        console.log("Profit USDC (6 dec):", loggedProfit);

        // CRITICAL SPEC REQUIREMENT: seized WETH must be exactly 1239431252024708050
        assertEq(loggedSeized, EXPECTED_SEIZED_WETH, "Seized WETH mismatch");

        // §6.5 Cost model verification
        _verifyCostModel(loggedProfit, gasUsedMeasured, usdcPrice);
    }

    /// @notice T2: No price injection reverts with Aave HealthFactorNotBelowThreshold error (§7)
    function testFork_T2_NoPriceInjectionReverts() public {
        (,,,,, uint256 hf) = IPool(POOL).getUserAccountData(BORROWER);
        assertGe(hf, 1e18, "Unmocked borrower HF must be >= 1e18");

        // Aave V3.1+ (revision 4) reverts with custom error HealthFactorNotBelowThreshold() (0x930bb771)
        vm.expectRevert(abi.encodeWithSignature("HealthFactorNotBelowThreshold()"));
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);
    }

    /// @notice T3: Losing route reverts and leaves liquidator balance unchanged (§7)
    function testFork_T3_LosingRouteReverts() public {
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        uint256 liquidatorUsdcBefore = IERC20(USDC).balanceOf(address(liquidator));
        uint256 liquidatorWethBefore = IERC20(WETH).balanceOf(address(liquidator));

        // Realized profit is 136139119; minProfit = 136139120 must revert
        uint256 unattainableProfit = 136139119 + 1;
        vm.expectRevert(
            abi.encodeWithSelector(FlashLiquidator.InsufficientProfit.selector, 136139119, unattainableProfit)
        );
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, unattainableProfit);

        assertEq(
            IERC20(USDC).balanceOf(address(liquidator)),
            liquidatorUsdcBefore,
            "Liquidator USDC balance must be unchanged"
        );
        assertEq(
            IERC20(WETH).balanceOf(address(liquidator)),
            liquidatorWethBefore,
            "Liquidator WETH balance must be unchanged"
        );
    }

    /// @notice T4: Slippage reverts with router Too little received error (§7)
    function testFork_T4_SlippageReverts() public {
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        // Achievable swap output is 2840468702; minSwapOut = 2840468703 must revert with router error
        uint256 unattainableSwapOut = 2840468702 + 1;
        vm.expectRevert(bytes("Too little received"));
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, unattainableSwapOut, 0);
    }

    /// @notice T5a: Non-owner liquidate reverts (§7)
    function testFork_T5a_NonOwnerLiquidateReverts() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.Unauthorized.selector);
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);
    }

    /// @notice T5b: Attacker calls executeOperation directly reverts (§7)
    function testFork_T5b_DirectExecuteOperationReverts() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.CallerNotPool.selector);
        liquidator.executeOperation(USDC, DEBT_TO_COVER, 0, address(liquidator), "");
    }

    /// @notice T5c: executeOperation rejects initiator != this (§7)
    function testFork_T5c_InvalidInitiatorReverts() public {
        address attacker = makeAddr("attacker");
        vm.prank(POOL);
        vm.expectRevert(FlashLiquidator.InitiatorNotSelf.selector);
        liquidator.executeOperation(USDC, DEBT_TO_COVER, 0, attacker, "");
    }

    /// @notice T5d: Attacker triggering flash loan targeting liquidator reverts with InitiatorNotSelf (§7)
    function testFork_T5d_AttackerTriggeredFlashLoanReverts() public {
        address attacker = makeAddr("attacker");
        bytes memory validParams = abi.encode(
            FlashLiquidator.LiquidationParams({
                collateral: WETH, user: BORROWER, poolFee: POOL_FEE, minSwapOut: 0, minProfit: 0, bal0: 0
            })
        );
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.InitiatorNotSelf.selector);
        IPool(POOL).flashLoanSimple(address(liquidator), USDC, 1000e6, validParams, 0);
    }

    /// @notice T6: withdraw moves profit to owner and rejects non-owner (§7)
    function testFork_T6_Withdraw() public {
        // Execute T1 to generate profit inside contract
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);

        uint256 contractUsdc = IERC20(USDC).balanceOf(address(liquidator));
        assertGt(contractUsdc, 0, "Liquidator contract must hold USDC profit");

        // Non-owner withdraw reverts
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(FlashLiquidator.Unauthorized.selector);
        liquidator.withdraw(USDC, attacker, contractUsdc);

        // Zero address withdraw reverts
        vm.expectRevert(FlashLiquidator.ZeroAddress.selector);
        liquidator.withdraw(USDC, address(0), contractUsdc);

        // Owner withdraw succeeds
        uint256 ownerUsdcBefore = IERC20(USDC).balanceOf(address(this));
        liquidator.withdraw(USDC, address(this), contractUsdc);

        assertEq(IERC20(USDC).balanceOf(address(liquidator)), 0, "Contract USDC balance must be 0 after withdraw");
        assertEq(
            IERC20(USDC).balanceOf(address(this)),
            ownerUsdcBefore + contractUsdc,
            "Owner must receive full withdrawn profit"
        );
    }

    /// @notice T7: Allowances are 0 for USDC and WETH after T1 (§7)
    function testFork_T7_AllowancesZeroAfterLiquidation() public {
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);

        assertEq(IERC20(USDC).allowance(address(liquidator), POOL), 0, "USDC allowance to POOL must be 0");
        assertEq(IERC20(WETH).allowance(address(liquidator), POOL), 0, "WETH allowance to POOL must be 0");
        assertEq(IERC20(USDC).allowance(address(liquidator), SWAP_ROUTER_02), 0, "USDC allowance to ROUTER must be 0");
        assertEq(IERC20(WETH).allowance(address(liquidator), SWAP_ROUTER_02), 0, "WETH allowance to ROUTER must be 0");
    }

    /// @notice T8: Pre-funded balance protection and bal0 baseline accounting
    function testFork_T8_PreFundedBalanceProtection() public {
        uint256 seedAmount = 500e6; // 500 USDC
        deal(USDC, address(liquidator), seedAmount);
        assertEq(IERC20(USDC).balanceOf(address(liquidator)), seedAmount, "Liquidator must have 500 USDC");

        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        // Sub-test A: Require minProfit = 200 USDC (achievable profit is ~136 USDC).
        // If stored 500 USDC were counted toward profit (i.e. bal0 omitted), currentBal (636 USDC) would pass.
        // With bal0 enforced, required is 500 + 2704.32 + 200 = 3404.32, which fails.
        uint256 unattainableProfit = 200e6;
        vm.expectRevert(
            abi.encodeWithSelector(FlashLiquidator.InsufficientProfit.selector, 136139119, unattainableProfit)
        );
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, unattainableProfit);

        // Assert liquidator still holds at least the seeded 500 USDC after revert
        assertGe(
            IERC20(USDC).balanceOf(address(liquidator)),
            seedAmount,
            "Liquidator must still hold >= 500 USDC after failed liquidation"
        );
        assertEq(
            IERC20(USDC).balanceOf(address(liquidator)), seedAmount, "Liquidator balance must remain exactly 500 USDC"
        );

        // Sub-test B: Successful T1 execution with pre-seeded 500 USDC
        vm.recordLogs();
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);

        // Verify profit measured strictly from bal0 baseline
        (,, uint256 loggedProfit) = _extractLiquidatedLog(vm.getRecordedLogs());
        assertEq(loggedProfit, 136139119, "Logged profit must be exactly 136139119 above bal0");
        assertEq(
            IERC20(USDC).balanceOf(address(liquidator)),
            seedAmount + 136139119,
            "Final balance must equal seedAmount + profit"
        );
    }

    /// @notice F1: Fuzz test on debtToCover and minProfit (§7)
    /// forge-config: default.fuzz.runs = 32
    function testFuzz_F1_Liquidation(uint256 debtToCover, uint256 minProfit) public {
        debtToCover = bound(debtToCover, 1e6, DEBT_TO_COVER);
        minProfit = bound(minProfit, 0, 1e8);

        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        // Separate assertion: full DEBT_TO_COVER with minProfit=0 must succeed in this setup
        uint256 snap = vm.snapshot();
        uint256 balPre = IERC20(USDC).balanceOf(address(liquidator));
        liquidator.liquidate(WETH, USDC, BORROWER, DEBT_TO_COVER, POOL_FEE, 0, 0);
        uint256 balPost = IERC20(USDC).balanceOf(address(liquidator));
        assertGe(balPost - balPre, 136139119, "Base liquidation must succeed");
        vm.revertTo(snap);

        // Fuzzed call
        uint256 balBefore = IERC20(USDC).balanceOf(address(liquidator));
        try liquidator.liquidate(WETH, USDC, BORROWER, debtToCover, POOL_FEE, 0, minProfit) {
            uint256 balAfter = IERC20(USDC).balanceOf(address(liquidator));
            assertGe(balAfter - balBefore, minProfit, "Realized profit must be >= minProfit");
        } catch {
            // Revert is allowed for unprofitable or invalid paths
        }

        // Allowances must always remain 0
        assertEq(IERC20(USDC).allowance(address(liquidator), POOL), 0, "Fuzz: USDC allowance to POOL must be 0");
        assertEq(IERC20(WETH).allowance(address(liquidator), POOL), 0, "Fuzz: WETH allowance to POOL must be 0");
        assertEq(
            IERC20(USDC).allowance(address(liquidator), SWAP_ROUTER_02), 0, "Fuzz: USDC allowance to ROUTER must be 0"
        );
        assertEq(
            IERC20(WETH).allowance(address(liquidator), SWAP_ROUTER_02), 0, "Fuzz: WETH allowance to ROUTER must be 0"
        );
    }

    // --- Helper Functions ---

    function _extractLiquidatedLog(Vm.Log[] memory entries)
        internal
        view
        returns (uint256 seized, uint256 swapOut, uint256 profit)
    {
        bytes32 sig = keccak256("Liquidated(address,address,address,uint256,uint256,uint256,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].emitter == address(liquidator) && entries[i].topics[0] == sig) {
                (, seized, swapOut, profit) = abi.decode(entries[i].data, (uint256, uint256, uint256, uint256));
                return (seized, swapOut, profit);
            }
        }
        revert("Liquidated event not found");
    }

    function _verifyCostModel(uint256 profitDebt, uint256 gasUsedMeasured, uint256 usdcPrice)
        internal
        pure
        returns (uint256 profitBase, uint256 gasCostBase)
    {
        profitBase = (profitDebt * usdcPrice) / 1e6;

        uint256 gasBase = gasUsedMeasured > REAL_GAS_USED ? gasUsedMeasured : REAL_GAS_USED;
        uint256 gasCostWei = GAS_MARGIN_MULTIPLIER * gasBase * REAL_EFFECTIVE_GAS_PRICE;
        gasCostBase = (gasCostWei * WETH_PRICE_INJECTED) / 1e18;

        console.log("Gas used measured:", gasUsedMeasured);
        console.log("Gas benchmark (max(measured, real)):", gasBase);
        console.log("Gas cost (wei):", gasCostWei);
        console.log("Gas cost Base (1e8 USD):", gasCostBase);
        console.log("Profit Base (1e8 USD):", profitBase);

        // Gate: profitBase > gasCostBase
        assertGt(profitBase, gasCostBase, "Gate failed: profitBase must exceed gasCostBase");
        console.log("Net Profit Base (1e8 USD):", profitBase - gasCostBase);
    }
}

/// @notice Invariant handler for I1 with ghost variables (§7)
contract FlashLiquidatorHandler is Test, P2LiquidationFixture {
    FlashLiquidator public immutable liquidator;
    uint256 public minObservedUsdc;
    bool public balanceDecreased;
    bool public changedOnRevert;

    constructor(FlashLiquidator _liquidator) {
        liquidator = _liquidator;
        minObservedUsdc = IERC20(USDC).balanceOf(address(_liquidator));
    }

    function actionLiquidate(uint256 senderSeed, uint256 debtToCover, uint256 minProfit) external {
        address sender;
        if (senderSeed % 2 == 0) {
            sender = liquidator.OWNER();
        } else {
            sender = address(uint160(senderSeed));
            if (sender == liquidator.OWNER()) sender = address(0xdead);
        }

        debtToCover = bound(debtToCover, 1e6, DEBT_TO_COVER);
        minProfit = bound(minProfit, 0, 1e8);

        uint256 balBefore = IERC20(USDC).balanceOf(address(liquidator));

        vm.prank(sender);
        try liquidator.liquidate(WETH, USDC, BORROWER, debtToCover, POOL_FEE, 0, minProfit) {
            uint256 balAfter = IERC20(USDC).balanceOf(address(liquidator));
            if (balAfter < balBefore) {
                balanceDecreased = true;
            }
            if (balAfter < minObservedUsdc) {
                minObservedUsdc = balAfter;
            }
        } catch {
            uint256 balAfter = IERC20(USDC).balanceOf(address(liquidator));
            if (balAfter != balBefore) {
                changedOnRevert = true;
            }
        }
    }
}

/// @notice I1: Invariant test suite with ghost variables (§7)
/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 5
contract FlashLiquidatorInvariantTest is Test, P2LiquidationFixture {
    FlashLiquidator internal liquidator;
    FlashLiquidatorHandler internal handler;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"), FORK_BLOCK);
        // Inject recorded WETH price on oracle
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IAaveOracle.getAssetPrice.selector, WETH), abi.encode(WETH_PRICE_INJECTED)
        );

        liquidator = new FlashLiquidator(IPool(POOL), ISwapRouter02(SWAP_ROUTER_02));
        handler = new FlashLiquidatorHandler(liquidator);

        targetContract(address(handler));
    }

    /// @notice Allowances always remain 0 across invariant runs
    function invariant_I1_AllowancesAlwaysZero() public view {
        assertEq(IERC20(USDC).allowance(address(liquidator), POOL), 0, "Invariant: USDC allowance to POOL != 0");
        assertEq(IERC20(WETH).allowance(address(liquidator), POOL), 0, "Invariant: WETH allowance to POOL != 0");
        assertEq(
            IERC20(USDC).allowance(address(liquidator), SWAP_ROUTER_02), 0, "Invariant: USDC allowance to ROUTER != 0"
        );
        assertEq(
            IERC20(WETH).allowance(address(liquidator), SWAP_ROUTER_02), 0, "Invariant: WETH allowance to ROUTER != 0"
        );
    }

    /// @notice USDC balance never decreases except through withdraw (verified via ghost variables)
    function invariant_I1_UsdcBalanceNeverDecreases() public view {
        assertFalse(handler.balanceDecreased(), "Invariant: USDC balance decreased");
        assertFalse(handler.changedOnRevert(), "Invariant: balance changed on revert");
        assertGe(
            IERC20(USDC).balanceOf(address(liquidator)),
            handler.minObservedUsdc(),
            "Invariant: USDC balance below minObservedUsdc"
        );
    }

    /// @notice OWNER is immutable and unchanged
    function invariant_I1_OwnerUnchanged() public view {
        assertEq(liquidator.OWNER(), address(this), "Invariant: OWNER changed");
    }
}
