import json

import pytest

from app.sentiment import LABELS
from app.sentiment.dataset import load_dataset
from app.sentiment.model import (
    Prediction,
    SentimentClassifier,
    cross_validate_model,
    evaluate,
    majority_baseline,
    split_examples,
)
from app.sentiment.train import main, run


@pytest.fixture(scope="module")
def examples():
    return load_dataset()


@pytest.fixture(scope="module")
def split(examples):
    return split_examples(examples)


@pytest.fixture(scope="module")
def classifier(split):
    train, _ = split
    return SentimentClassifier.train(train)


def test_split_is_stratified_disjoint_and_reproducible(examples):
    train, test = split_examples(examples)
    assert len(train) + len(test) == len(examples)
    assert not {e.text for e in train} & {e.text for e in test}
    assert {e.label for e in test} == set(LABELS)
    per_label = {label: sum(e.label == label for e in test) for label in LABELS}
    assert max(per_label.values()) - min(per_label.values()) <= 1
    assert split_examples(examples) == (train, test)


def test_holdout_metrics_clear_a_sane_floor(classifier, split):
    _, test = split
    metrics = evaluate(classifier.pipeline, test)
    baseline = majority_baseline(split[0], test)
    assert metrics["macro_f1"] >= 0.6
    assert metrics["macro_f1"] >= baseline["macro_f1"] + 0.3
    assert set(metrics["per_class"]) == set(LABELS)
    assert sum(c["support"] for c in metrics["per_class"].values()) == len(test)
    matrix = metrics["confusion_matrix"]["matrix"]
    assert sum(map(sum, matrix)) == len(test)


def test_cross_validation_clears_a_sane_floor(examples):
    cv = cross_validate_model(examples)
    assert cv["folds"] == 5
    assert len(cv["macro_f1"]["folds"]) == 5
    assert cv["macro_f1"]["mean"] >= 0.6


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Absolutely love it, works perfectly and looks fantastic!", "positive"),
        ("Terrible quality, it broke after one day. Complete waste of money.", "negative"),
        ("The package arrived on Tuesday in a cardboard box.", "neutral"),
    ],
)
def test_obvious_examples_are_classified(classifier, text, expected):
    assert classifier.predict_one(text).label == expected


@pytest.mark.parametrize(
    ("affirmative", "negated"),
    [("happy", "not happy"), ("The screen is good", "The screen is not good")],
)
def test_negation_shifts_probability_towards_negative(classifier, affirmative, negated):
    plain = classifier.predict_one(affirmative).probabilities
    flipped = classifier.predict_one(negated).probabilities
    assert flipped["negative"] > plain["negative"]
    assert flipped["positive"] < plain["positive"]


def test_prediction_structure(classifier):
    predictions = classifier.predict(["Great service!", "Awful experience."])
    assert len(predictions) == 2
    for prediction in predictions:
        assert isinstance(prediction, Prediction)
        assert type(prediction.label) is str
        assert prediction.label in LABELS
        assert set(prediction.probabilities) == set(LABELS)
        assert sum(prediction.probabilities.values()) == pytest.approx(1.0, abs=1e-3)
        assert prediction.confidence == max(prediction.probabilities.values())


def test_predict_empty_list_returns_empty_list(classifier):
    assert classifier.predict([]) == []


def test_predict_rejects_non_string(classifier):
    with pytest.raises(TypeError):
        classifier.predict([None])


def test_save_and_load_roundtrip(classifier, tmp_path):
    path = classifier.save(tmp_path / "nested" / "model.joblib")
    loaded = SentimentClassifier.load(path)
    texts = ["Great service!", "Awful experience.", "It arrived on Monday."]
    assert loaded.predict(texts) == classifier.predict(texts)


def test_training_is_deterministic(split):
    train, test = split
    first = evaluate(SentimentClassifier.train(train).pipeline, test)
    second = evaluate(SentimentClassifier.train(train).pipeline, test)
    assert first == second


def test_run_writes_metrics_report_and_model(tmp_path):
    model_path = tmp_path / "model.joblib"
    report = run(report_dir=tmp_path, model_path=model_path)

    written = json.loads((tmp_path / "metrics.json").read_text(encoding="utf-8"))
    assert written == report
    assert set(written) == {"dataset", "config", "holdout", "cross_validation"}
    assert written["holdout"]["train_size"] + written["holdout"]["test_size"] == written["dataset"]["size"]
    assert model_path.exists()
    assert SentimentClassifier.load(model_path).predict_one("Love it!").label in LABELS


def test_cli_can_skip_saving_the_model(tmp_path, capsys):
    model_path = tmp_path / "model.joblib"
    exit_code = main(
        ["--report-dir", str(tmp_path), "--model-path", str(model_path), "--no-save-model"]
    )
    assert exit_code == 0
    assert (tmp_path / "metrics.json").exists()
    assert not model_path.exists()
    assert "holdout macro-F1" in capsys.readouterr().out
