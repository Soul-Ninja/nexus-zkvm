// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20, IPool, ISwapRouter02, IFlashLoanSimpleReceiver} from "./interfaces/IFlashLiquidatorDeps.sol";

/// @title FlashLiquidator
/// @notice Single-hop flash-liquidation MVP contract on Aave V3 Arbitrum One
/// @dev Implements Aave V3 flashLoanSimple receiver and single-hop Uniswap V3 swap via SwapRouter02
contract FlashLiquidator is IFlashLoanSimpleReceiver {
    // --- Structs ---
    struct LiquidationParams {
        address collateral;
        address user;
        uint24 poolFee;
        uint256 minSwapOut;
        uint256 minProfit;
        uint256 bal0;
    }

    // --- Custom Errors ---
    error Unauthorized();
    error SameAsset();
    error CallerNotPool();
    error InitiatorNotSelf();
    error NoCollateralSeized();
    error InsufficientProfit(uint256 actualProfit, uint256 minProfit);
    error SafeApproveFailed();
    error SafeTransferFailed();
    error ZeroAddress();

    // --- Events ---
    event Liquidated(
        address indexed collateral,
        address indexed debt,
        address indexed user,
        uint256 debtToCover,
        uint256 seized,
        uint256 swapOut,
        uint256 profit
    );
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    // --- Immutables (§6.1) ---
    IPool public immutable POOL;
    ISwapRouter02 public immutable ROUTER;
    address public immutable OWNER;

    constructor(IPool pool, ISwapRouter02 router) {
        if (address(pool) == address(0) || address(router) == address(0)) {
            revert ZeroAddress();
        }
        POOL = pool;
        ROUTER = router;
        OWNER = msg.sender;
    }

    /// @notice Owner-only entry point to trigger a flash loan and liquidation
    /// @param collateral Address of collateral token to seize
    /// @param debt Address of debt token to flash-borrow and repay
    /// @param user Address of undercollateralized borrower
    /// @param debtToCover Amount of debt to liquidate
    /// @param poolFee Uniswap V3 pool fee tier for collateral -> debt swap (e.g. 500 for 0.05%)
    /// @param minSwapOut Minimum amount of debt asset acceptable from collateral swap (slippage protection)
    /// @param minProfit Minimum net profit in debt asset required above principal + premium
    function liquidate(
        address collateral,
        address debt,
        address user,
        uint256 debtToCover,
        uint24 poolFee,
        uint256 minSwapOut,
        uint256 minProfit
    ) external {
        if (msg.sender != OWNER) revert Unauthorized();
        if (collateral == debt) revert SameAsset();

        uint256 bal0 = IERC20(debt).balanceOf(address(this));
        bytes memory params = abi.encode(
            LiquidationParams({
                collateral: collateral,
                user: user,
                poolFee: poolFee,
                minSwapOut: minSwapOut,
                minProfit: minProfit,
                bal0: bal0
            })
        );

        POOL.flashLoanSimple(address(this), debt, debtToCover, params, 0);
    }

    /// @notice Aave V3 flash loan callback
    /// @param asset Flash-borrowed debt asset
    /// @param amount Amount borrowed
    /// @param premium Flash loan fee owed to Aave
    /// @param initiator Initiator of the flash loan
    /// @param params Encoded liquidation parameters
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != address(POOL)) revert CallerNotPool();
        if (initiator != address(this)) revert InitiatorNotSelf();

        LiquidationParams memory p = abi.decode(params, (LiquidationParams));

        uint256 seized = _liquidateAndSeize(asset, amount, p);
        _swapAndRepay(asset, amount, premium, seized, p);

        return true;
    }

    /// @notice Owner-only withdrawal of accumulated tokens
    /// @param token Address of token to withdraw
    /// @param to Recipient address
    /// @param amount Amount to withdraw
    function withdraw(address token, address to, uint256 amount) external {
        if (msg.sender != OWNER) revert Unauthorized();
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(token, to, amount);
        _safeTransfer(token, to, amount);
    }

    // --- Internal Liquidation & Swap Steps ---

    function _liquidateAndSeize(address debt, uint256 amount, LiquidationParams memory p)
        private
        returns (uint256 seized)
    {
        // Step 3: Approve POOL for amount of debt, then call liquidationCall
        _safeApprove(debt, address(POOL), amount);
        uint256 collateralBefore = IERC20(p.collateral).balanceOf(address(this));
        POOL.liquidationCall(p.collateral, debt, p.user, amount, false);

        // Step 4: seized = balance delta
        uint256 collateralAfter = IERC20(p.collateral).balanceOf(address(this));
        if (collateralAfter <= collateralBefore) revert NoCollateralSeized();
        seized = collateralAfter - collateralBefore;
    }

    function _swapAndRepay(address debt, uint256 amount, uint256 premium, uint256 seized, LiquidationParams memory p)
        private
    {
        // Step 5: Approve ROUTER for exactly seized and call exactInputSingle
        _safeApprove(p.collateral, address(ROUTER), seized);
        uint256 swapOut = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: p.collateral,
                tokenOut: debt,
                fee: p.poolFee,
                recipient: address(this),
                amountIn: seized,
                amountOutMinimum: p.minSwapOut,
                sqrtPriceLimitX96: 0
            })
        );
        _safeApprove(p.collateral, address(ROUTER), 0);

        // Step 6: Require debt.balanceOf(this) >= bal0 + amount + premium + minProfit
        uint256 currentBal = IERC20(debt).balanceOf(address(this));
        uint256 totalOwed = amount + premium;
        uint256 requiredBal = p.bal0 + totalOwed + p.minProfit;
        if (currentBal < requiredBal) {
            uint256 actualProfit = currentBal > (p.bal0 + totalOwed) ? currentBal - (p.bal0 + totalOwed) : 0;
            revert InsufficientProfit(actualProfit, p.minProfit);
        }

        uint256 profit = currentBal - p.bal0 - totalOwed;
        emit Liquidated(p.collateral, debt, p.user, amount, seized, swapOut, profit);

        // Step 7: Approve POOL for exactly amount + premium and return true.
        // Reset allowance to 0 first in case liquidationCall consumed less than amount
        _safeApprove(debt, address(POOL), 0);
        _safeApprove(debt, address(POOL), totalOwed);
    }

    // --- Private Token Helpers (§6.3) ---

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeApproveFailed();
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed();
        }
    }
}
