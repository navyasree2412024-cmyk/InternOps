"""Sentiment analysis pipeline for customer feedback.

Classifies free-text feedback as ``positive``, ``neutral`` or ``negative``.

The package is deliberately *not* imported by ``app.main``: it is an offline
training/evaluation pipeline and its scikit-learn dependency lives in the dev
dependency group, so the production image is unaffected.

Modules:
    preprocessing  text cleaning (stdlib only)
    dataset        labeled CSV loading and validation (stdlib only)
    model          TF-IDF + logistic regression baseline (needs scikit-learn)
    train          command-line entry point: ``python -m app.sentiment.train``
"""

LABELS: tuple[str, ...] = ("negative", "neutral", "positive")
