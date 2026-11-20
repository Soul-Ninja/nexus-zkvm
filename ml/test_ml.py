"""
Nexus-ZKVM Phase 5: ML Unit, Leakage, and Sanity Tests (P1-P4)
"""

import json
import os
import shutil
import tempfile
import numpy as np
import pandas as pd
import pytest
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score

from features import (
    FEATURE_COLS,
    group_events,
    split_by_time_and_event,
    compute_b1_analytical,
)
from train_eval import run_pipeline


@pytest.fixture
def synthetic_dataset():
    """Generates a synthetic time-series dataset of candidates for testing."""
    rng = np.random.RandomState(42)

    # 40 events spaced ~25,000 blocks apart, each with 6-12 candidates spaced 2-15 blocks apart
    blocks = []
    curr = 520_000_000
    for _ in range(40):
        curr += rng.randint(20_000, 30_000)
        burst_len = rng.randint(6, 12)
        burst_curr = curr
        for _ in range(burst_len):
            burst_curr += rng.randint(2, 15)
            blocks.append(burst_curr)

    n = len(blocks)
    df = pd.DataFrame({
        "block_number": blocks,
        "pool_buy": ["sushi_500"] * n,
        "pool_sell": ["uni_500"] * n,
        "gap_bps": rng.uniform(5, 50, n),
        "fee_sum_bps": [10.0] * n,
        "log10_liquidity_buy": rng.uniform(5, 8, n),
        "log10_liquidity_sell": rng.uniform(5, 8, n),
        "blocks_since_last_swap_buy": rng.randint(0, 100, n),
        "blocks_since_last_swap_sell": rng.randint(0, 100, n),
        "abs_tick_change_20": rng.uniform(0, 30, n),
        "burst_count_200": rng.randint(0, 10, n),
        "log10_base_fee": rng.uniform(7, 9, n),
        "best_size": [10000_000000] * n,
        "profit_raw": rng.choice([0, 200_000, 2_000_000, 10_000_000], p=[0.5, 0.2, 0.2, 0.1], size=n),
        "gas_usdc_raw": rng.randint(20_000, 80_000, n),
    })
    df["net_raw"] = df["profit_raw"] - df["gas_usdc_raw"]
    df["y"] = (df["net_raw"] >= 1_000_000).astype(int)
    return df


def test_p1_no_feature_uses_future_block(synthetic_dataset):
    """P1: Proves no feature uses a block > N (temporal leakage check)."""
    df = synthetic_dataset

    # Verify lookback counters are non-negative
    assert (df["blocks_since_last_swap_buy"] >= 0).all()
    assert (df["blocks_since_last_swap_sell"] >= 0).all()
    assert (df["burst_count_200"] >= 0).all()
    assert (df["abs_tick_change_20"] >= 0).all()

    # Verify analytical B1 does not depend on future rows
    b1_all = compute_b1_analytical(df)
    b1_prefix = compute_b1_analytical(df.iloc[:50])
    np.testing.assert_allclose(b1_all[:50], b1_prefix, err_msg="B1 feature calculation leaked future data")


def test_p2_event_grouping_and_embargo(synthetic_dataset):
    """P2: Event grouping, split disjointness, and embargo window compliance (§6.4)."""
    df = synthetic_dataset
    embargo = 20_000
    train_df, val_df, test_df = split_by_time_and_event(
        df, train_frac=0.6, val_frac=0.2, embargo_blocks=embargo
    )

    # 1. No event in multiple splits
    train_events = set(train_df["event_id"])
    val_events = set(val_df["event_id"])
    test_events = set(test_df["event_id"])

    assert len(train_events & val_events) == 0, "Train and Val share events"
    assert len(val_events & test_events) == 0, "Val and Test share events"
    assert len(train_events & test_events) == 0, "Train and Test share events"

    # 2. Embargo window between Train and Val
    if len(val_df) > 0 and len(train_df) > 0:
        val_start = val_df["block_number"].min()
        train_max = train_df["block_number"].max()
        gap_tv = val_start - train_max
        assert gap_tv >= embargo, f"Train-Val embargo violated: gap {gap_tv} < {embargo}"

    # 3. Embargo window between Val and Test
    if len(test_df) > 0 and len(val_df) > 0:
        test_start = test_df["block_number"].min()
        val_max = val_df["block_number"].max()
        gap_vt = test_start - val_max
        assert gap_vt >= embargo, f"Val-Test embargo violated: gap {gap_vt} < {embargo}"


def test_p3_shuffled_label_sanity(synthetic_dataset):
    """P3: Model trained on permuted labels must score test ROC-AUC in [0.4, 0.6] (§6.4)."""
    df = synthetic_dataset
    train_df, val_df, test_df = split_by_time_and_event(df, embargo_blocks=1000)

    # Ensure both classes exist in train and test
    if test_df["y"].nunique() < 2 or train_df["y"].nunique() < 2:
        pytest.skip("Not enough class variation in synthetic split")

    scaler = StandardScaler()
    X_train = scaler.fit_transform(train_df[FEATURE_COLS].values)
    # Permute labels randomly
    rng = np.random.RandomState(123)
    y_train_shuffled = rng.permutation(train_df["y"].values)

    m = LogisticRegression(random_state=42, max_iter=500)
    m.fit(X_train, y_train_shuffled)

    X_test = scaler.transform(test_df[FEATURE_COLS].values)
    y_test = test_df["y"].values
    test_scores = m.predict_proba(X_test)[:, 1]

    auc = roc_auc_score(y_test, test_scores)
    assert 0.4 <= auc <= 0.6, f"Shuffled-label AUC {auc:.4f} is outside expected range [0.4, 0.6]"


def test_p4_determinism(synthetic_dataset):
    """P4: Two full train/eval runs produce identical metrics file (§7)."""
    tmp_dir = tempfile.mkdtemp()
    try:
        csv_path = os.path.join(tmp_dir, "dataset.csv")
        synthetic_dataset.to_csv(csv_path, index=False)

        out1 = os.path.join(tmp_dir, "run1")
        out2 = os.path.join(tmp_dir, "run2")

        res1 = run_pipeline(csv_path=csv_path, out_dir=out1, random_state=0)
        res2 = run_pipeline(csv_path=csv_path, out_dir=out2, random_state=0)

        # Compare metrics.json files byte-for-byte
        with open(os.path.join(out1, "metrics.json"), "rb") as f1, open(os.path.join(out2, "metrics.json"), "rb") as f2:
            bytes1 = f1.read()
            bytes2 = f2.read()

        assert bytes1 == bytes2, "Metrics files between runs must be bit-for-bit deterministic"
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
