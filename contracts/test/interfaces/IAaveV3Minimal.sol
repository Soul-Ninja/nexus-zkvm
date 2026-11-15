// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
    function getPriceOracleSentinel() external view returns (address);
    function getACLManager() external view returns (address);
}

interface IPool {
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

    function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider);
}

interface IPriceOracleGetter {
    function BASE_CURRENCY() external view returns (address);
    function BASE_CURRENCY_UNIT() external view returns (uint256);
}

interface IAaveOracle is IPriceOracleGetter {}
