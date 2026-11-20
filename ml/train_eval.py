"""
Nexus-ZKVM Phase 5: Model Training, Evaluation, and Adoption Rule Gating
"""

import json
import os
import sys
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, brier_score_loss

from features import (
    FEATURE_COLS,
    split_by_time_and_event,
    compute_b1_analytical,
)

BLOCKS_PER_DAY = 345_600  # ~4 blocks/sec on Arbitrum One


def compute_precision_at_k(y_true: np.ndarray, scores: np.ndarray, k: int) -> float:
    """Computes Precision@k: fraction of top-k ranked items that are positive (y=1)."""
    if len(y_true) == 0:
        return 0.0
    top_k_indices = np.argsort(scores)[::-1][:k]
    return float(np.mean(y_true[top_k_indices]))


def compute_daily_pnl_capture(
    test_df: pd.DataFrame, scores: np.ndarray, k: int
) -> tuple[float, float, float]:
    """
    Computes budgeted PnL capture at budget k per day (§6.6):
    For each day of test data, select top-k ranked candidates.
    Returns (captured_pnl, oracle_pnl, capture_ratio).
    """
    if len(test_df) == 0:
        return 0.0, 0.0, 0.0

    df = test_df.copy()
    df["score"] = scores
    df["profit_pos"] = np.maximum(df["net_raw"].values.astype(float), 0.0)

    start_block = df["block_number"].min()
    df["day"] = (df["block_number"] - start_block) // BLOCKS_PER_DAY

    total_captured = 0.0
    total_oracle = 0.0

    for _, day_group in df.groupby("day"):
        # Model top-k
        top_k_model = day_group.sort_values("score", ascending=False).head(k)
        total_captured += float(top_k_model["profit_pos"].sum())

        # Oracle top-k
        top_k_oracle = day_group.sort_values("profit_pos", ascending=False).head(k)
        total_oracle += float(top_k_oracle["profit_pos"].sum())

    ratio = (total_captured / total_oracle) if total_oracle > 0 else 0.0
    return total_captured, total_oracle, ratio


def bootstrap_pnl_ci(
    test_df: pd.DataFrame,
    score_dict: dict[str, np.ndarray],
    k: int = 3,
    n_resamples: int = 1000,
    seed: int = 0,
) -> dict:
    """
    Computes 95% bootstrap confidence interval over test EVENTS (§6.6).
    Returns CI for each ranker and difference (M - B) vs best baseline.
    """
    rng = np.random.RandomState(seed)
    event_ids = test_df["event_id"].unique()
    n_events = len(event_ids)

    if n_events == 0:
        return {}

    names = list(score_dict.keys())
    sampled_ratios = {name: [] for name in names}
    sampled_diffs = {name: [] for name in ["M1", "M2"]}

    # Pre-map event_id to dataframe index
    event_indices = {eid: test_df.index[test_df["event_id"] == eid].values for eid in event_ids}

    for _ in range(n_resamples):
        chosen_events = rng.choice(event_ids, size=n_events, replace=True)
        chosen_idx = np.concatenate([event_indices[eid] for eid in chosen_events])
        sub_df = test_df.loc[chosen_idx]

        ratios = {}
        for name in names:
            sub_scores = score_dict[name][test_df.index.get_indexer(chosen_idx)]
            _, _, r = compute_daily_pnl_capture(sub_df, sub_scores, k)
            ratios[name] = r
            sampled_ratios[name].append(r)

        # Baseline max
        b_max = max(ratios.get("B0", 0.0), ratios.get("B1", 0.0))
        for m_name in ["M1", "M2"]:
            if m_name in ratios:
                sampled_diffs[m_name].append(ratios[m_name] - b_max)

    ci_results = {}
    for name in names:
        arr = np.array(sampled_ratios[name])
        ci_results[name] = {
            "mean": float(np.mean(arr)),
            "ci_lower": float(np.percentile(arr, 2.5)),
            "ci_upper": float(np.percentile(arr, 97.5)),
        }

    diff_results = {}
    for m_name in ["M1", "M2"]:
        if m_name in sampled_diffs and len(sampled_diffs[m_name]) > 0:
            arr = np.array(sampled_diffs[m_name])
            diff_results[m_name] = {
                "mean_diff": float(np.mean(arr)),
                "ci_lower": float(np.percentile(arr, 2.5)),
                "ci_upper": float(np.percentile(arr, 97.5)),
                "excludes_zero": bool(np.percentile(arr, 2.5) > 0.0),
            }

    return {"pnl_ci": ci_results, "diff_vs_baseline_ci": diff_results}


def compute_reliability_table(
    y_true: np.ndarray, probas: np.ndarray, n_bins: int = 10
) -> list[dict]:
    """Computes 10-bin calibration reliability table (§6.6)."""
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    table = []
    for b in range(n_bins):
        low, high = bins[b], bins[b + 1]
        mask = (probas >= low) & (probas <= high) if b == n_bins - 1 else (probas >= low) & (probas < high)
        count = int(np.sum(mask))
        mean_pred = float(np.mean(probas[mask])) if count > 0 else 0.0
        observed_freq = float(np.mean(y_true[mask])) if count > 0 else 0.0
        table.append({
            "bin": b,
            "range": f"[{low:.1f}, {high:.1f}]",
            "count": count,
            "mean_pred": mean_pred,
            "observed_freq": observed_freq,
        })
    return table


def run_pipeline(
    csv_path: str = "ml/data/dataset.csv",
    out_dir: str = "ml/data",
    random_state: int = 0,
) -> dict:
    """Executes model training, validation selection, test evaluation, and adoption rule."""
    if not os.path.exists(csv_path):
        raise FileNotFoundError(f"Dataset not found at {csv_path}. Run 'dataset build' first.")

    df = pd.read_csv(csv_path)
    train_df, val_df, test_df = split_by_time_and_event(df)

    counts = {
        "train": {
            "candidates": len(train_df),
            "events": int(train_df["event_id"].nunique()) if len(train_df) > 0 else 0,
            "positives": int(train_df["y"].sum()) if len(train_df) > 0 else 0,
        },
        "val": {
            "candidates": len(val_df),
            "events": int(val_df["event_id"].nunique()) if len(val_df) > 0 else 0,
            "positives": int(val_df["y"].sum()) if len(val_df) > 0 else 0,
        },
        "test": {
            "candidates": len(test_df),
            "events": int(test_df["event_id"].nunique()) if len(test_df) > 0 else 0,
            "positives": int(test_df["y"].sum()) if len(test_df) > 0 else 0,
        },
    }

    test_positives = counts["test"]["positives"]
    test_events = counts["test"]["events"]

    # Failure handling / finding condition (§11)
    finding_too_few = test_positives < 30 or test_events < 10

    # Fit Scaler and Models on Train
    X_train = train_df[FEATURE_COLS].values.astype(float)
    y_train = train_df["y"].values.astype(int)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)

    # Train M1: Logistic Regression
    m1 = None
    if len(np.unique(y_train)) > 1:
        m1 = LogisticRegression(random_state=random_state, max_iter=1000)
        m1.fit(X_train_scaled, y_train)

    # Train M2: HistGradientBoosting
    m2 = None
    if len(np.unique(y_train)) > 1:
        m2 = HistGradientBoostingClassifier(random_state=random_state)
        m2.fit(X_train, y_train)

    # Validation Evaluation for Model Selection
    X_val = val_df[FEATURE_COLS].values.astype(float)
    X_val_scaled = scaler.transform(X_val)
    val_scores = {
        "B0": val_df["gap_bps"].values.astype(float),
        "B1": compute_b1_analytical(val_df),
        "M1": m1.predict_proba(X_val_scaled)[:, 1] if m1 is not None else np.zeros(len(val_df)),
        "M2": m2.predict_proba(X_val)[:, 1] if m2 is not None else np.zeros(len(val_df)),
    }

    # Evaluate on TEST SET ONCE (§6.5)
    X_test = test_df[FEATURE_COLS].values.astype(float)
    X_test_scaled = scaler.transform(X_test)
    y_test = test_df["y"].values.astype(int)

    test_scores = {
        "B0": test_df["gap_bps"].values.astype(float),
        "B1": compute_b1_analytical(test_df),
        "M1": m1.predict_proba(X_test_scaled)[:, 1] if m1 is not None else np.zeros(len(test_df)),
        "M2": m2.predict_proba(X_test)[:, 1] if m2 is not None else np.zeros(len(test_df)),
    }

    metrics = {}
    for name, s in test_scores.items():
        # ROC-AUC
        try:
            auc = float(roc_auc_score(y_test, s)) if len(np.unique(y_test)) > 1 else 0.5
        except Exception:
            auc = 0.5

        # Precision @ k
        p1 = compute_precision_at_k(y_test, s, 1)
        p3 = compute_precision_at_k(y_test, s, 3)
        p10 = compute_precision_at_k(y_test, s, 10)

        # Budgeted PnL capture
        _, _, pnl1 = compute_daily_pnl_capture(test_df, s, 1)
        _, _, pnl3 = compute_daily_pnl_capture(test_df, s, 3)
        _, _, pnl10 = compute_daily_pnl_capture(test_df, s, 10)

        # Brier score
        brier = float(brier_score_loss(y_test, s)) if name in ["M1", "M2"] else None

        metrics[name] = {
            "pnl_capture_k1": pnl1,
            "pnl_capture_k3": pnl3,
            "pnl_capture_k10": pnl10,
            "roc_auc": auc,
            "precision_k1": p1,
            "precision_k3": p3,
            "precision_k10": p10,
            "brier_score": brier,
        }

    # Calibration tables for M1, M2
    calibration = {
        "M1": compute_reliability_table(y_test, test_scores["M1"]),
        "M2": compute_reliability_table(y_test, test_scores["M2"]),
    }

    # Bootstrap 95% CI over test events
    bootstrap = bootstrap_pnl_ci(test_df, test_scores, k=3, n_resamples=1000, seed=0)

    # Adoption Rule (§6.7)
    # A model is adopted as advisory ranker only if:
    # 1. Primary metric at k=3 beats both B0 and B1 on test, AND
    # 2. Bootstrap 95% CI of the difference excludes 0.
    b0_pnl3 = metrics["B0"]["pnl_capture_k3"]
    b1_pnl3 = metrics["B1"]["pnl_capture_k3"]
    best_baseline_pnl3 = max(b0_pnl3, b1_pnl3)
    best_baseline_name = "B0" if b0_pnl3 >= b1_pnl3 else "B1"

    adopted_model = None
    adoption_verdict = f"Keep baseline {best_baseline_name}"
    adoption_reason = ""

    if finding_too_few:
        adoption_verdict = f"Default to baseline {best_baseline_name} (Finding: test positives < 30 or events < 10)"
        adoption_reason = f"Test positives ({test_positives} < 30) or events ({test_events} < 10) below minimum threshold per §11."
    else:
        # Check M2 first (higher capacity), then M1
        for candidate_name in ["M2", "M1"]:
            cand_pnl3 = metrics[candidate_name]["pnl_capture_k3"]
            diff_ci = bootstrap.get("diff_vs_baseline_ci", {}).get(candidate_name, {})
            excludes_zero = diff_ci.get("excludes_zero", False)

            if cand_pnl3 > b0_pnl3 and cand_pnl3 > b1_pnl3 and excludes_zero:
                adopted_model = candidate_name
                adoption_verdict = f"Adopt {candidate_name} as advisory ranker"
                adoption_reason = f"{candidate_name} pnl@3 ({cand_pnl3:.4f}) beats B0 ({b0_pnl3:.4f}) and B1 ({b1_pnl3:.4f}), and bootstrap 95% CI of diff ({diff_ci.get('ci_lower', 0):.4f}, {diff_ci.get('ci_upper', 0):.4f}) excludes 0."
                break

        if not adopted_model:
            adoption_verdict = f"Keep baseline {best_baseline_name}"
            m2_diff = bootstrap.get("diff_vs_baseline_ci", {}).get("M2", {})
            adoption_reason = f"Neither M1 nor M2 met the §6.7 adoption criteria. M2 diff vs baseline 95% CI is [{m2_diff.get('ci_lower', 0):.4f}, {m2_diff.get('ci_upper', 0):.4f}]."

    results = {
        "counts": counts,
        "finding_too_few": finding_too_few,
        "metrics": metrics,
        "bootstrap": bootstrap,
        "calibration": calibration,
        "adoption": {
            "verdict": adoption_verdict,
            "adopted_model": adopted_model or best_baseline_name,
            "reason": adoption_reason,
            "best_baseline": best_baseline_name,
        },
    }

    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "metrics.json")
    with open(out_file, "w") as f:
        json.dump(results, f, indent=2)

    return results


def print_summary(res: dict):
    """Prints tabular summary of results."""
    counts = res["counts"]
    metrics = res["metrics"]
    adoption = res["adoption"]

    print("\n" + "=" * 65)
    print("PHASE 5 ML EVALUATION: SUMMARY")
    print("=" * 65)

    print("\n--- Split Counts ---")
    print(f"{'Split':<8} | {'Candidates':<12} | {'Events':<8} | {'Positives':<10}")
    print("-" * 46)
    for s in ["train", "val", "test"]:
        print(f"{s:<8} | {counts[s]['candidates']:<12} | {counts[s]['events']:<8} | {counts[s]['positives']:<10}")

    print("\n--- Test Set Metrics ---")
    header = f"{'Ranker':<8} | {'PnL@1':<8} | {'PnL@3':<8} | {'PnL@10':<8} | {'ROC-AUC':<8} | {'Prec@3':<8} | {'Brier':<8}"
    print(header)
    print("-" * len(header))
    for name in ["B0", "B1", "M1", "M2"]:
        m = metrics[name]
        brier_str = f"{m['brier_score']:.4f}" if m["brier_score"] is not None else "N/A"
        print(
            f"{name:<8} | {m['pnl_capture_k1']:<8.4f} | {m['pnl_capture_k3']:<8.4f} | {m['pnl_capture_k10']:<8.4f} | "
            f"{m['roc_auc']:<8.4f} | {m['precision_k3']:<8.4f} | {brier_str:<8}"
        )

    print("\n--- Adoption Verdict (§6.7) ---")
    print(f"Verdict: {adoption['verdict']}")
    print(f"Reason:  {adoption['reason']}")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "ml/data/dataset.csv"
    res = run_pipeline(csv_path)
    print_summary(res)
