import pytest

from app.sentiment.preprocessing import NEGATION_SCOPE, preprocess


def test_lowercases_and_tokenises():
    assert preprocess("Great Product") == "great product"


def test_strips_html_urls_and_emails():
    text = "<p>Loved it</p> see https://example.com/x or www.shop.io, mail me@example.com"
    assert preprocess(text) == "loved it see or mail"


def test_unescapes_html_entities_and_normalises_unicode():
    assert preprocess("fast &amp; reliable") == "fast reliable"
    assert preprocess("It\u2019s great") == "it great"  # curly apostrophe


def test_expands_contractions_so_negation_is_visible():
    assert preprocess("didn't work", mark_negation=False) == "did not work"
    assert preprocess("can't stop, won't stop", mark_negation=False) == "can not stop will not stop"


def test_collapses_elongated_words():
    assert preprocess("sooooo good") == "soo good"


def test_keeps_exclamation_and_question_marks_only():
    assert preprocess("Great, really. Why?!") == "great really why ? !"


def test_marks_negated_tokens():
    assert preprocess("not good") == "not not_good"
    assert preprocess("I never liked it") == "i never not_liked not_it"


def test_negation_scope_is_limited():
    tokens = preprocess("not one two three four").split()
    assert tokens[0] == "not"
    assert tokens[1 : 1 + NEGATION_SCOPE] == ["not_one", "not_two", "not_three"]
    assert tokens[-1] == "four"


def test_negation_scope_ends_at_punctuation_and_contrast_words():
    assert preprocess("not cheap. great") == "not not_cheap great"
    assert preprocess("not cheap but great") == "not not_cheap but great"


def test_negation_marking_can_be_disabled():
    assert preprocess("not good", mark_negation=False) == "not good"


@pytest.mark.parametrize("text", ["", "   ", "!!!", "https://example.com"])
def test_degenerate_input_does_not_crash(text):
    assert isinstance(preprocess(text), str)


@pytest.mark.parametrize("bad", [None, 42, ["text"], b"bytes"])
def test_rejects_non_string_input(bad):
    with pytest.raises(TypeError):
        preprocess(bad)
