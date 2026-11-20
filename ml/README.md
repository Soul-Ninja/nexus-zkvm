# Nexus-ZKVM Phase 5 — ML Ranking vs Rule Baselines

Offline evaluation of learned ranking models versus rule-based heuristics for WETH/USDC arbitrage candidate blocks on Arbitrum One.

## Setup
```bash
python3 -m venv ml/.venv
ml/.venv/bin/pip install --require-hashes -r ml/requirements.txt
```

## Running Tests & Training
```bash
# Run ML unit and leakage tests
ml/.venv/bin/python -m pytest ml/test_ml.py

# Run model training and evaluation
ml/.venv/bin/python ml/train_eval.py
```

## Structure
- `features.py`: Feature definitions, event grouping, time-based splitting, and analytical profit baseline calculation.
- `train_eval.py`: Trains baselines (B0, B1) and models (M1, M2), calculates evaluation metrics, computes bootstrap confidence intervals, and outputs adoption verdict.
- `test_ml.py`: Tests for temporal leakage (P1), event grouping & embargo (P2), shuffled-label sanity (P3), and determinism (P4).
- `data/`: Cached dataset and logs (git-ignored).
