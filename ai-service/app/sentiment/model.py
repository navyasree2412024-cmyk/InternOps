"""Baseline sentiment model: TF-IDF (1-2 grams) + logistic regression.

Requires scikit-learn, which is part of the ``dev`` dependency group and is
intentionally absent from the production image (``uv sync`` installs it).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.sentiment import LABELS
from app.sentiment.dataset import Example
from app.sentiment.preprocessing import preprocess

try:
    import joblib
    from sklearn.dummy import DummyClassifier
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import classification_report, confusion_matrix
    from sklearn.model_selection import StratifiedKFold, cross_validate, train_test_split
    from sklearn.pipeline import Pipeline
except ImportError as exc:  # pragma: no cover - exercised only without dev deps
    raise ImportError(
        "app.sentiment.model requires scikit-learn. Install dev dependencies with `uv sync`."
    ) from exc

RANDOM_SEED = 42
DEFAULT_TEST_SIZE = 0.2
DEFAULT_CV_FOLDS = 5

# Hyper-parameters are fixed rather than tuned: with ~180 examples any search
# would overfit the validation folds. See docs/SENTIMENT_ANALYSIS.md.
MODEL_CONFIG: dict[str, Any] = {
    "vectorizer": "TfidfVectorizer",
    "ngram_range": [1, 2],
    "sublinear_tf": True,
    "classifier": "LogisticRegression",
    "C": 10.0,
    "class_weight": "balanced",
    "max_iter": 1000,
}


@dataclass(frozen=True)
class Prediction:
    """Predicted label with the model's class probabilities."""

    label: str
    confidence: float
    probabilities: dict[str, float]


def build_pipeline(seed: int = RANDOM_SEED) -> Pipeline:
    """Create an untrained TF-IDF + logistic-regression pipeline."""
    return Pipeline(
        [
            (
                "tfidf",
                TfidfVectorizer(
                    preprocessor=preprocess,  # also lower-cases
                    lowercase=False,
                    token_pattern=r"\S+",  # tokens are already whitespace-separated
                    ngram_range=tuple(MODEL_CONFIG["ngram_range"]),
                    sublinear_tf=MODEL_CONFIG["sublinear_tf"],
                ),
            ),
            (
                "clf",
                LogisticRegression(
                    C=MODEL_CONFIG["C"],
                    class_weight=MODEL_CONFIG["class_weight"],
                    max_iter=MODEL_CONFIG["max_iter"],
                    random_state=seed,
                ),
            ),
        ]
    )


def split_examples(
    examples: Sequence[Example],
    test_size: float = DEFAULT_TEST_SIZE,
    seed: int = RANDOM_SEED,
) -> tuple[list[Example], list[Example]]:
    """Stratified train/test split (label proportions preserved)."""
    train, test = train_test_split(
        list(examples),
        test_size=test_size,
        random_state=seed,
        stratify=[example.label for example in examples],
    )
    return train, test


def evaluate(pipeline: Any, examples: Sequence[Example]) -> dict[str, Any]:
    """Score a fitted classifier on ``examples``.

    Returns accuracy, macro/weighted F1, per-class precision/recall/F1/support
    and a confusion matrix whose rows are true labels and columns predictions,
    both ordered as ``labels``.
    """
    y_true = [example.label for example in examples]
    y_pred = pipeline.predict([example.text for example in examples])
    report = classification_report(
        y_true, y_pred, labels=list(LABELS), output_dict=True, zero_division=0
    )
    return {
        "accuracy": round(report["accuracy"], 4),
        "macro_f1": round(report["macro avg"]["f1-score"], 4),
        "weighted_f1": round(report["weighted avg"]["f1-score"], 4),
        "per_class": {
            label: {
                "precision": round(report[label]["precision"], 4),
                "recall": round(report[label]["recall"], 4),
                "f1": round(report[label]["f1-score"], 4),
                "support": int(report[label]["support"]),
            }
            for label in LABELS
        },
        "confusion_matrix": {
            "labels": list(LABELS),
            "rows_are": "true label",
            "columns_are": "predicted label",
            "matrix": confusion_matrix(y_true, y_pred, labels=list(LABELS)).tolist(),
        },
    }


def majority_baseline(train: Sequence[Example], test: Sequence[Example]) -> dict[str, Any]:
    """Metrics of a classifier that always predicts the most frequent label."""
    dummy = DummyClassifier(strategy="most_frequent")
    dummy.fit([e.text for e in train], [e.label for e in train])
    return evaluate(dummy, test)


def cross_validate_model(
    examples: Sequence[Example],
    folds: int = DEFAULT_CV_FOLDS,
    seed: int = RANDOM_SEED,
) -> dict[str, Any]:
    """Stratified k-fold cross-validation over the whole dataset."""
    splitter = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    scores = cross_validate(
        build_pipeline(seed),
        [example.text for example in examples],
        [example.label for example in examples],
        cv=splitter,
        scoring={"accuracy": "accuracy", "macro_f1": "f1_macro"},
    )

    def summarise(values: Any) -> dict[str, Any]:
        return {
            "mean": round(float(values.mean()), 4),
            "std": round(float(values.std()), 4),
            "folds": [round(float(v), 4) for v in values],
        }

    return {
        "folds": folds,
        "accuracy": summarise(scores["test_accuracy"]),
        "macro_f1": summarise(scores["test_macro_f1"]),
    }


class SentimentClassifier:
    """Trained sentiment model with a small prediction API."""

    def __init__(self, pipeline: Any) -> None:
        self._pipeline = pipeline

    @classmethod
    def train(cls, examples: Sequence[Example], seed: int = RANDOM_SEED) -> SentimentClassifier:
        pipeline = build_pipeline(seed)
        pipeline.fit([e.text for e in examples], [e.label for e in examples])
        return cls(pipeline)

    @property
    def pipeline(self) -> Any:
        return self._pipeline

    def predict(self, texts: Sequence[str]) -> list[Prediction]:
        """Classify each text. Raises ``TypeError`` for non-string items."""
        if not texts:
            return []
        classes = [str(label) for label in self._pipeline.classes_]
        results = []
        for row in self._pipeline.predict_proba(list(texts)):
            probabilities = {label: round(float(p), 4) for label, p in zip(classes, row)}
            label = max(probabilities, key=probabilities.__getitem__)
            results.append(Prediction(label, probabilities[label], probabilities))
        return results

    def predict_one(self, text: str) -> Prediction:
        return self.predict([text])[0]

    def save(self, path: str | Path) -> Path:
        """Persist the model with joblib (pickle-based: only load files you trust)."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self._pipeline, path)
        return path

    @classmethod
    def load(cls, path: str | Path) -> SentimentClassifier:
        return cls(joblib.load(path))
