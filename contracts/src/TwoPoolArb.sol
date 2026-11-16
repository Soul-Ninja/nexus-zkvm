// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IUniswapV3PoolMinimal, IERC20} from "./interfaces/IUniswapV3PoolMinimal.sol";

/// @title TwoPoolArb
/// @notice Single-transaction two-pool arbitrage executor across Uniswap-V3-style pools
/// @dev Holds expectedPool in storage slot 0 per spec §6.4 and test T8
contract TwoPoolArb {
    address public immutable OWNER;

    /// @notice Address of the pool currently authorized to invoke uniswapV3SwapCallback
    /// @dev Occupies storage slot 0 (OWNER is immutable). Always address(0) outside active arb().
    address public expectedPool;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    event Arbitraged(
        address indexed poolBuy,
        address indexed poolSell,
        uint256 amountIn,
        uint256 midOut,
        uint256 receivedOut,
        uint256 profit
    );

    error Unauthorized();
    error PoolTokenMismatch();
    error PartialFill();
    error InsufficientProfit(uint256 actual, uint256 minProfit);
    error UnexpectedCaller();
    error ZeroAddress();
    error SafeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert Unauthorized();
        _;
    }

    constructor() {
        OWNER = msg.sender;
    }

    function _limitFor(bool zeroForOne) private pure returns (uint160) {
        return zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed();
        }
    }

    function _validatePool(address pool, address tA, address tB) private view {
        address t0 = IUniswapV3PoolMinimal(pool).token0();
        address t1 = IUniswapV3PoolMinimal(pool).token1();
        bool matchPair = (t0 == tA && t1 == tB) || (t0 == tB && t1 == tA);
        if (!matchPair) revert PoolTokenMismatch();
    }

    function _buyExactInput(address poolBuy, address tokenIn, uint256 amountIn) private returns (uint256 midOut) {
        address b0 = IUniswapV3PoolMinimal(poolBuy).token0();
        address b1 = IUniswapV3PoolMinimal(poolBuy).token1();
        bool zf = (tokenIn == b0);

        expectedPool = poolBuy;
        (int256 a0, int256 a1) =
            IUniswapV3PoolMinimal(poolBuy).swap(address(this), zf, int256(amountIn), _limitFor(zf), abi.encode(b0, b1));

        int256 inDelta = zf ? a0 : a1;
        int256 outDelta = zf ? a1 : a0;

        if (inDelta != int256(amountIn)) {
            revert PartialFill();
        }
        return uint256(-outDelta);
    }

    function _sellExactInput(address poolSell, address tokenMid, uint256 midOut) private returns (uint256 receivedOut) {
        address s0 = IUniswapV3PoolMinimal(poolSell).token0();
        address s1 = IUniswapV3PoolMinimal(poolSell).token1();
        bool zf = (tokenMid == s0);

        expectedPool = poolSell;
        (int256 a0, int256 a1) =
            IUniswapV3PoolMinimal(poolSell).swap(address(this), zf, int256(midOut), _limitFor(zf), abi.encode(s0, s1));

        int256 midDelta = zf ? a0 : a1;
        int256 outDelta = zf ? a1 : a0;

        if (midDelta != int256(midOut)) {
            revert PartialFill();
        }
        return uint256(-outDelta);
    }

    /// @notice Execute two-pool arbitrage: exact-input buy on poolBuy, exact-input sell on poolSell
    /// @param poolBuy Pool where tokenMid is bought (exact input of tokenIn)
    /// @param poolSell Pool where tokenMid is sold (exact input of all tokenMid received)
    /// @param tokenIn Starting and profit token
    /// @param tokenMid Intermediate traded token
    /// @param amountIn Exact amount of tokenIn spent on the buy leg
    /// @param minProfit Minimum required gain in tokenIn
    function arb(
        address poolBuy,
        address poolSell,
        address tokenIn,
        address tokenMid,
        uint256 amountIn,
        uint256 minProfit
    ) external onlyOwner {
        if (poolBuy == poolSell || tokenIn == tokenMid) {
            revert PoolTokenMismatch();
        }

        _validatePool(poolBuy, tokenIn, tokenMid);
        _validatePool(poolSell, tokenIn, tokenMid);

        uint256 bal0 = IERC20(tokenIn).balanceOf(address(this));

        // 1. Buy leg: exact input of tokenIn (amountIn)
        uint256 midOut = _buyExactInput(poolBuy, tokenIn, amountIn);

        // 2. Sell leg: exact input of all tokenMid received (midOut)
        uint256 receivedOut = _sellExactInput(poolSell, tokenMid, midOut);

        // 3. Clear expectedPool
        expectedPool = address(0);

        // 4. Enforce profit invariant
        uint256 balAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 actualProfit = balAfter > bal0 ? balAfter - bal0 : 0;
        if (balAfter < bal0 + minProfit) {
            revert InsufficientProfit(actualProfit, minProfit);
        }

        emit Arbitraged(poolBuy, poolSell, amountIn, midOut, receivedOut, actualProfit);
    }

    /// @notice Uniswap V3 swap callback for token transfer settlement
    /// @dev Validates caller matches expectedPool and expectedPool != address(0)
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != expectedPool || expectedPool == address(0)) {
            revert UnexpectedCaller();
        }
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Delta > 0) {
            _safeTransfer(token0, msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            _safeTransfer(token1, msg.sender, uint256(amount1Delta));
        }
    }

    /// @notice Owner-only withdrawal of tokens
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _safeTransfer(token, to, amount);
    }
}
