// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal ERC-20 interface for FlashLiquidator
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice Minimal Aave V3 Pool interface for FlashLiquidator
interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function ADDRESSES_PROVIDER() external view returns (address);
}

/// @notice Minimal Uniswap SwapRouter02 interface for exactInputSingle
/// @dev Sourced from Uniswap/swap-router-contracts (commit 8fe4f086cee7c08f0bdb6ebe20c9ab615921c65f, tag v1.1.0)
/// Docs: https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function factory() external view returns (address);
}

/// @notice Aave V3 flash loan simple receiver callback interface
interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @notice Minimal Aave V3 Oracle interface for testing & price queries
interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
    function BASE_CURRENCY() external view returns (address);
    function BASE_CURRENCY_UNIT() external view returns (uint256);
}

/// @notice Minimal Aave V3 PoolAddressesProvider interface
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
    function getPriceOracleSentinel() external view returns (address);
    function getACLManager() external view returns (address);
}
