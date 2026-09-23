"""Train and evaluate the sentiment baseline.

Run from the ``ai-service`` directory::

    uv run python -m app.sentiment.train

Writes ``reports/sentiment/metrics.json`` (committed, human-readable results)
and ``artifacts/sentiment/model.joblib`` (git-ignored trained model).
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import sklearn

from app.sentiment.dataset import (
    AI_SERVICE_ROOT,
    DEFAULT_DATASET_PATH,
    label_counts,
    load_dataset,
    source_counts,
)
from app.sentiment.model import (
    DEFAULT_CV_FOLDS,
    DEFAULT_TEST_SIZE,
    MODEL_CONFIG,
    RANDOM_SEED,
    SentimentClassifier,
    cross_validate_model,
    evaluate,
    majority_baseline,
    split_examples,
)

DEFAULT_REPORT_DIR = AI_SERVICE_ROOT / "reports" / "sentiment"
DEFAULT_MODEL_PATH = AI_SERVICE_ROOT / "artifacts" / "sentiment" / "model.joblib"


def _display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(AI_SERVICE_ROOT).as_posix()
    except ValueError:
        return path.name


def run(
    data_path: Path = DEFAULT_DATASET_PATH,
    report_dir: Path = DEFAULT_REPORT_DIR,
    model_path: Path | None = DEFAULT_MODEL_PATH,
    test_size: float = DEFAULT_TEST_SIZE,
    folds: int = DEFAULT_CV_FOLDS,
    seed: int = RANDOM_SEED,
) -> dict[str, Any]:
    """Train, evaluate, write the metrics report and (optionally) the model.

    Pass ``model_path=None`` to skip saving the trained model.
    Returns the metrics report.
    """
    examples = load_dataset(data_path)
    train, test = split_examples(examples, test_size=test_size, seed=seed)

    classifier = SentimentClassifier.train(train, seed=seed)
    report: dict[str, Any] = {
        "dataset": {
            "path": _display_path(data_path),
            "size": len(examples),
            "label_counts": label_counts(examples),
            "source_counts": source_counts(examples),
        },
        "config": {
            "seed": seed,
            "test_size": test_size,
            "cv_folds": folds,
            "model": MODEL_CONFIG,
            "scikit_learn": sklearn.__version__,
        },
        "holdout": {
            "train_size": len(train),
            "test_size": len(test),
            "model": evaluate(classifier.pipeline, test),
            "majority_class_baseline": majority_baseline(train, test),
        },
        "cross_validation": cross_validate_model(examples, folds=folds, seed=seed),
    }

    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "metrics.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    if model_path is not None:
        # Ship the final model trained on every labeled example.
        SentimentClassifier.train(examples, seed=seed).save(model_path)
    return report


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=DEFAULT_DATASET_PATH)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    parser.add_argument("--model-path", type=Path, default=DEFAULT_MODEL_PATH)
    parser.add_argument("--no-save-model", action="store_true", help="skip writing the model file")
    parser.add_argument("--test-size", type=float, default=DEFAULT_TEST_SIZE)
    parser.add_argument("--folds", type=int, default=DEFAULT_CV_FOLDS)
    parser.add_argument("--seed", type=int, default=RANDOM_SEED)
    args = parser.parse_args(argv)

    report = run(
        data_path=args.data,
        report_dir=args.report_dir,
        model_path=None if args.no_save_model else args.model_path,
        test_size=args.test_size,
        folds=args.folds,
        seed=args.seed,
    )
    holdout = report["holdout"]["model"]
    cv = report["cross_validation"]
    print(f"holdout accuracy : {holdout['accuracy']:.4f}")
    print(f"holdout macro-F1 : {holdout['macro_f1']:.4f}")
    print(
        f"{cv['folds']}-fold CV macro-F1: {cv['macro_f1']['mean']:.4f} +/- {cv['macro_f1']['std']:.4f}"
    )
    print(f"metrics written to {args.report_dir / 'metrics.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
