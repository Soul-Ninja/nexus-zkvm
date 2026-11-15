// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IPool, IPoolAddressesProvider, IAaveOracle} from "../interfaces/IAaveV3Minimal.sol";
import {AaveV3ArbitrumFixture} from "../fixtures/AaveV3ArbitrumFixture.sol";

contract AaveV3ArbitrumForkTest is Test, AaveV3ArbitrumFixture {
    IPool internal pool;
    IPoolAddressesProvider internal addressesProvider;
    IAaveOracle internal oracle;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"), FORK_BLOCK);
        pool = IPool(POOL);
        addressesProvider = IPoolAddressesProvider(POOL_ADDRESSES_PROVIDER);
        oracle = IAaveOracle(ORACLE);
    }

    /// @notice §7.2 Verify chain ID is pinned to Arbitrum One (42161)
    function testFork_ChainPinned() public view {
        assertEq(block.chainid, CHAIN_ID, "block.chainid mismatch");

        console.log("=== testFork_ChainPinned ===");
        console.log("block.chainid:", block.chainid);
        console.log("block.number:", block.number);
        console.log("vm.getBlockNumber():", vm.getBlockNumber());
        console.log("FORK_BLOCK:", FORK_BLOCK);
    }

    /// @notice §7.3 Verify registry consistency against on-chain contracts
    function testFork_RegistryConsistency() public view {
        assertGt(POOL.code.length, 0, "POOL code length is 0");
        assertGt(POOL_ADDRESSES_PROVIDER.code.length, 0, "POOL_ADDRESSES_PROVIDER code length is 0");
        assertGt(ORACLE.code.length, 0, "ORACLE code length is 0");

        assertEq(addressesProvider.getPool(), POOL, "getPool mismatch");
        assertEq(addressesProvider.getPriceOracle(), ORACLE, "getPriceOracle mismatch");
        assertEq(address(pool.ADDRESSES_PROVIDER()), POOL_ADDRESSES_PROVIDER, "ADDRESSES_PROVIDER mismatch");

        uint256 baseUnit = oracle.BASE_CURRENCY_UNIT();
        address baseCurrency = oracle.BASE_CURRENCY();

        assertEq(baseUnit, EXPECTED_BASE_CURRENCY_UNIT, "BASE_CURRENCY_UNIT mismatch");
        assertEq(baseCurrency, EXPECTED_BASE_CURRENCY, "BASE_CURRENCY mismatch");

        address sentinel = addressesProvider.getPriceOracleSentinel();
        address aclManager = addressesProvider.getACLManager();

        (bool success, bytes memory ret) = POOL.staticcall(abi.encodeWithSignature("POOL_REVISION()"));
        uint256 revision = 0;
        if (success && ret.length >= 32) {
            revision = abi.decode(ret, (uint256));
        }

        console.log("=== testFork_RegistryConsistency ===");
        console.log("PriceOracleSentinel:", sentinel);
        console.log("ACLManager:", aclManager);
        console.log("POOL_REVISION() success:", success);
        console.log("POOL_REVISION() value:", revision);
    }

    /// @notice §7.4 Verify borrower account data against exact expected values
    function testFork_BorrowerAccountData() public view {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) = pool.getUserAccountData(BORROWER);

        assertEq(totalCollateralBase, EXPECTED_TOTAL_COLLATERAL_BASE, "totalCollateralBase mismatch");
        assertEq(totalDebtBase, EXPECTED_TOTAL_DEBT_BASE, "totalDebtBase mismatch");
        assertEq(availableBorrowsBase, EXPECTED_AVAILABLE_BORROWS_BASE, "availableBorrowsBase mismatch");
        assertEq(
            currentLiquidationThreshold, EXPECTED_CURRENT_LIQUIDATION_THRESHOLD, "currentLiquidationThreshold mismatch"
        );
        assertEq(ltv, EXPECTED_LTV, "ltv mismatch");
        assertEq(healthFactor, EXPECTED_HEALTH_FACTOR, "healthFactor mismatch");

        assertGt(totalDebtBase, 0, "totalDebtBase must be > 0");
        assertGt(totalCollateralBase, 0, "totalCollateralBase must be > 0");
        assertGt(healthFactor, HEALTH_FACTOR_LIQUIDATION_THRESHOLD, "healthFactor must be > 1e18");
        assertLt(healthFactor, type(uint256).max, "healthFactor must be < type(uint256).max");

        console.log("=== testFork_BorrowerAccountData ===");
        console.log("Borrower:", BORROWER);
        console.log("totalCollateralBase (1e8 USD):", totalCollateralBase);
        console.log("totalDebtBase (1e8 USD):", totalDebtBase);
        console.log("availableBorrowsBase (1e8 USD):", availableBorrowsBase);
        console.log("currentLiquidationThreshold (bps):", currentLiquidationThreshold);
        console.log("ltv (bps):", ltv);
        console.log("healthFactor (WAD 1e18):", healthFactor);
    }

    /// @notice §7.4b Verify empty account control behavior
    function testFork_EmptyAccountControl() public {
        address emptyAccount = makeAddr("nexus-empty-account");

        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) = pool.getUserAccountData(emptyAccount);

        assertEq(totalCollateralBase, 0, "empty totalCollateralBase must be 0");
        assertEq(totalDebtBase, 0, "empty totalDebtBase must be 0");
        assertEq(availableBorrowsBase, 0, "empty availableBorrowsBase must be 0");
        assertEq(currentLiquidationThreshold, 0, "empty currentLiquidationThreshold must be 0");
        assertEq(ltv, 0, "empty ltv must be 0");
        assertEq(healthFactor, type(uint256).max, "empty healthFactor must be type(uint256).max");

        console.log("=== testFork_EmptyAccountControl ===");
        console.log("Empty Account:", emptyAccount);
        console.log("healthFactor:", healthFactor);
    }

    /// @notice §7.5a Conditional fixture: fork at block L - 1 before liquidation
    function testFork_LiquidatableBorrower_PreLiquidationBlock() public {
        vm.createSelectFork(vm.rpcUrl("arbitrum"), LIQ_FORK_BLOCK);

        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        ) = IPool(POOL).getUserAccountData(LIQ_BORROWER);

        assertEq(totalCollateralBase, LIQ_EXPECTED_TOTAL_COLLATERAL_BASE, "LIQ totalCollateralBase mismatch");
        assertEq(totalDebtBase, LIQ_EXPECTED_TOTAL_DEBT_BASE, "LIQ totalDebtBase mismatch");
        assertEq(availableBorrowsBase, LIQ_EXPECTED_AVAILABLE_BORROWS_BASE, "LIQ availableBorrowsBase mismatch");
        assertEq(
            currentLiquidationThreshold,
            LIQ_EXPECTED_CURRENT_LIQUIDATION_THRESHOLD,
            "LIQ currentLiquidationThreshold mismatch"
        );
        assertEq(ltv, LIQ_EXPECTED_LTV, "LIQ ltv mismatch");
        assertEq(healthFactor, LIQ_EXPECTED_HEALTH_FACTOR, "LIQ healthFactor mismatch");

        assertGt(totalDebtBase, 0, "LIQ totalDebtBase must be > 0");
        assertGt(totalCollateralBase, 0, "LIQ totalCollateralBase must be > 0");
        assertLt(healthFactor, HEALTH_FACTOR_LIQUIDATION_THRESHOLD, "LIQ healthFactor must be < 1e18");

        console.log("=== testFork_LiquidatableBorrower_PreLiquidationBlock ===");
        console.log("LIQ Fork Block (L - 1):", LIQ_FORK_BLOCK);
        console.log("LIQ Borrower:", LIQ_BORROWER);
        console.log("totalCollateralBase (1e8 USD):", totalCollateralBase);
        console.log("totalDebtBase (1e8 USD):", totalDebtBase);
        console.log("healthFactor (WAD 1e18):", healthFactor);
    }

    /// @notice §7.5b Conditional fixture: observation fork at transaction TX_L
    function testFork_LiquidatableBorrower_TxForkObservation() public {
        try vm.createSelectFork(vm.rpcUrl("arbitrum"), LIQ_TX_L) {
            (uint256 totalCollateralBase, uint256 totalDebtBase,,,, uint256 healthFactor) =
                IPool(POOL).getUserAccountData(LIQ_BORROWER);

            console.log("=== testFork_LiquidatableBorrower_TxForkObservation ===");
            console.log("TX_L fork successful");
            console.log("totalCollateralBase:", totalCollateralBase);
            console.log("totalDebtBase:", totalDebtBase);
            console.log("healthFactor:", healthFactor);
        } catch Error(string memory reason) {
            console.log("=== testFork_LiquidatableBorrower_TxForkObservation ===");
            console.log("TX_L fork failed with reason:", reason);
        } catch (bytes memory lowLevelData) {
            console.log("=== testFork_LiquidatableBorrower_TxForkObservation ===");
            console.log("TX_L fork failed with low level data");
            console.logBytes(lowLevelData);
        }
    }
}
