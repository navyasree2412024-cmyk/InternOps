import json

import pytest

from app.sentiment import LABELS
from app.sentiment.dataset import (
    AI_SERVICE_ROOT,
    DEFAULT_DATASET_PATH,
    Example,
    label_counts,
    load_dataset,
    source_counts,
)


def write_csv(tmp_path, body, header="id,text,label,source"):
    path = tmp_path / "data.csv"
    path.write_text(f"{header}\n{body}", encoding="utf-8")
    return path


def test_shipped_dataset_is_valid_and_labeled():
    examples = load_dataset()
    assert len(examples) >= 150
    assert all(isinstance(e, Example) for e in examples)
    assert {e.label for e in examples} == set(LABELS)


def test_shipped_dataset_is_balanced():
    counts = label_counts(load_dataset())
    assert set(counts) == set(LABELS)
    assert max(counts.values()) - min(counts.values()) <= 5


def test_shipped_dataset_covers_multiple_sources():
    assert len(source_counts(load_dataset())) >= 3


def test_committed_metrics_report_matches_current_dataset():
    """Guards against editing the dataset without re-running the training script."""
    report = json.loads(
        (AI_SERVICE_ROOT / "reports" / "sentiment" / "metrics.json").read_text(encoding="utf-8")
    )
    examples = load_dataset(DEFAULT_DATASET_PATH)
    assert report["dataset"]["size"] == len(examples)
    assert report["dataset"]["label_counts"] == label_counts(examples)


def test_load_normalises_labels_and_whitespace(tmp_path):
    path = write_csv(tmp_path, "1,  Nice one  , POSITIVE ,web\n2,Meh,neutral,\n")
    assert load_dataset(path) == [
        Example("Nice one", "positive", "web"),
        Example("Meh", "neutral", "unknown"),
    ]


def test_load_handles_quoted_commas(tmp_path):
    path = write_csv(tmp_path, '1,"Good, but pricey",neutral,web\n')
    assert load_dataset(path)[0].text == "Good, but pricey"


def test_load_works_without_optional_columns(tmp_path):
    path = write_csv(tmp_path, "Fine,neutral\n", header="text,label")
    assert load_dataset(path) == [Example("Fine", "neutral", "unknown")]


def test_load_rejects_unknown_label_with_line_number(tmp_path):
    path = write_csv(tmp_path, "1,Fine,neutral,web\n2,Bad,angry,web\n")
    with pytest.raises(ValueError, match=r"data\.csv:3: unknown label 'angry'"):
        load_dataset(path)


def test_load_rejects_empty_text(tmp_path):
    path = write_csv(tmp_path, "1,   ,positive,web\n")
    with pytest.raises(ValueError, match="empty text"):
        load_dataset(path)


def test_load_rejects_duplicate_text_ignoring_case_and_spacing(tmp_path):
    path = write_csv(tmp_path, "1,Great  stuff,positive,web\n2,great stuff,positive,web\n")
    with pytest.raises(ValueError, match="duplicate text"):
        load_dataset(path)


def test_load_rejects_missing_required_column(tmp_path):
    path = write_csv(tmp_path, "1,Fine\n", header="id,text")
    with pytest.raises(ValueError, match="missing required column"):
        load_dataset(path)


def test_load_rejects_empty_dataset(tmp_path):
    path = write_csv(tmp_path, "")
    with pytest.raises(ValueError, match="empty"):
        load_dataset(path)


def test_load_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_dataset(tmp_path / "nope.csv")
