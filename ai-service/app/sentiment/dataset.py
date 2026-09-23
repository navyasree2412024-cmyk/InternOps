"""Loading and validation of the labeled feedback dataset (standard library only).

CSV format (UTF-8, header required)::

    id,text,label,source

``text`` and ``label`` are mandatory. ``label`` must be one of
:data:`app.sentiment.LABELS`. ``id`` and ``source`` are optional metadata.
"""

from __future__ import annotations

import csv
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from app.sentiment import LABELS

AI_SERVICE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATASET_PATH = AI_SERVICE_ROOT / "data" / "sentiment" / "customer_feedback.csv"


@dataclass(frozen=True)
class Example:
    """One labeled piece of customer feedback."""

    text: str
    label: str
    source: str = "unknown"


def load_dataset(path: str | Path = DEFAULT_DATASET_PATH) -> list[Example]:
    """Read and validate a labeled dataset.

    Raises:
        FileNotFoundError: if ``path`` does not exist.
        ValueError: on a missing column, empty text, unknown label, duplicate
            text (which would leak between train and test splits) or an empty
            dataset. The message names the offending CSV line.
    """
    path = Path(path)
    examples: list[Example] = []
    seen: dict[str, int] = {}

    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        missing = {"text", "label"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path.name}: missing required column(s): {sorted(missing)}")

        for row in reader:
            line = reader.line_num
            text = (row.get("text") or "").strip()
            label = (row.get("label") or "").strip().lower()
            if not text:
                raise ValueError(f"{path.name}:{line}: empty text")
            if label not in LABELS:
                raise ValueError(
                    f"{path.name}:{line}: unknown label {label!r}, expected one of {LABELS}"
                )
            key = " ".join(text.lower().split())
            if key in seen:
                raise ValueError(
                    f"{path.name}:{line}: duplicate text (first seen on line {seen[key]})"
                )
            seen[key] = line
            examples.append(Example(text, label, (row.get("source") or "unknown").strip()))

    if not examples:
        raise ValueError(f"{path.name}: dataset is empty")
    return examples


def label_counts(examples: list[Example]) -> dict[str, int]:
    """Number of examples per label, in :data:`LABELS` order (zeros included)."""
    counts = Counter(example.label for example in examples)
    return {label: counts.get(label, 0) for label in LABELS}


def source_counts(examples: list[Example]) -> dict[str, int]:
    """Number of examples per source, sorted by source name."""
    return dict(sorted(Counter(example.source for example in examples).items()))
