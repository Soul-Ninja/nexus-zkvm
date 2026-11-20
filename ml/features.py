"""
Nexus-ZKVM Phase 5: Feature Engineering, Event Grouping, and Splitting
"""

import numpy as np
import pandas as pd

FEATURE_COLS = [
    "gap_bps",
    "fee_sum_bps",
    "log10_liquidity_buy",
    "log10_liquidity_sell",
    "blocks_since_last_swap_buy",
    "blocks_since_last_swap_sell",
    "abs_tick_change_20",
    "burst_count_200",
    "log10_base_fee",
]

SIZE_LADDER = np.array([1000e6, 2500e6, 5000e6, 10000e6, 20000e6])


def group_events(df: pd.DataFrame, max_distance: int = 50) -> pd.DataFrame:
    """
    Groups consecutive candidates within max_distance blocks of each other into events (§6.4).
    """
    df = df.sort_values("block_number").copy()
    diffs = df["block_number"].diff()
    new_event = (diffs > max_distance) | diffs.isna()
    df["event_id"] = new_event.cumsum() - 1
    return df


def split_by_time_and_event(
    df: pd.DataFrame,
    train_frac: float = 0.6,
    val_frac: float = 0.2,
    embargo_blocks: int = 20_000,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Splits data into train (60%), validation (20%), and test (20%) by time-ordered events,
    with an embargo buffer of embargo_blocks before each split boundary (§6.4).
    No event straddles a split boundary.
    """
    df = group_events(df)
    unique_events = df["event_id"].unique()
    n_events = len(unique_events)

    if n_events == 0:
        return df.iloc[0:0], df.iloc[0:0], df.iloc[0:0]

    n_train_events = max(1, int(round(train_frac * n_events)))
    n_val_events = max(1, int(round(val_frac * n_events)))

    # Ensure train, val, test all have events if n_events >= 3
    if n_events >= 3:
        if n_train_events + n_val_events >= n_events:
            n_val_events = max(1, n_events - n_train_events - 1)
        train_event_ids = set(unique_events[:n_train_events])
        val_event_ids = set(unique_events[n_train_events : n_train_events + n_val_events])
        test_event_ids = set(unique_events[n_train_events + n_val_events :])
    else:
        train_event_ids = set(unique_events[:1])
        val_event_ids = set(unique_events[1:2])
        test_event_ids = set(unique_events[2:])

    train_df = df[df["event_id"].isin(train_event_ids)].copy()
    val_df = df[df["event_id"].isin(val_event_ids)].copy()
    test_df = df[df["event_id"].isin(test_event_ids)].copy()

    # Apply embargo (§6.4): drop events within embargo_blocks before split boundaries
    if len(val_df) > 0 and len(train_df) > 0:
        val_start_block = val_df["block_number"].min()
        embargo_train_cutoff = val_start_block - embargo_blocks
        # Drop events whose max block_number is within embargo window
        train_event_maxes = train_df.groupby("event_id")["block_number"].max()
        dropped_train_events = train_event_maxes[train_event_maxes >= embargo_train_cutoff].index
        train_df = train_df[~train_df["event_id"].isin(dropped_train_events)].copy()

    if len(test_df) > 0 and len(val_df) > 0:
        test_start_block = test_df["block_number"].min()
        embargo_val_cutoff = test_start_block - embargo_blocks
        val_event_maxes = val_df.groupby("event_id")["block_number"].max()
        dropped_val_events = val_event_maxes[val_event_maxes >= embargo_val_cutoff].index
        val_df = val_df[~val_df["event_id"].isin(dropped_val_events)].copy()

    return train_df, val_df, test_df


def compute_b1_analytical(df: pd.DataFrame) -> np.ndarray:
    """
    Computes B1 analytical estimate: closed-form single-range V3 profit from
    gap_bps, both pools' liquidity and fees, at the best ladder size, minus gas (§6.5).
    """
    gap_ratio = df["gap_bps"].values.astype(float) / 10000.0
    fee_sum_ratio = df["fee_sum_bps"].values.astype(float) / 10000.0
    liq_buy = np.power(10.0, df["log10_liquidity_buy"].values.astype(float))
    liq_sell = np.power(10.0, df["log10_liquidity_sell"].values.astype(float))
    base_fee = np.power(10.0, df["log10_base_fee"].values.astype(float))

    # Gas cost in raw USDC: 2 * 600,000 * baseFee * P_weth / 1e12
    # P_weth approx 2500 USD (6 decimals: 2500e6)
    approx_weth_usd = 2500.0
    gas_usdc = 2.0 * 600_000.0 * base_fee * approx_weth_usd / 1e12

    b1_scores = np.zeros(len(df))

    # Ladder sweep in raw USDC: [1000e6, 2500e6, 5000e6, 10000e6, 20000e6]
    for i in range(len(df)):
        edge = gap_ratio[i] - fee_sum_ratio[i]
        inv_liq = 0.5 * (1.0 / max(1.0, liq_buy[i]) + 1.0 / max(1.0, liq_sell[i]))
        # Best analytical net profit across ladder sizes
        profits = []
        for s in SIZE_LADDER:
            # Slippage impact approx s * inv_liq * 1e-6
            impact = s * inv_liq * 1e-6
            net = s * (edge - impact) - gas_usdc[i]
            profits.append(net)
        b1_scores[i] = max(profits)

    return b1_scores
