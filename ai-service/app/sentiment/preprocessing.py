"""Text cleaning for sentiment analysis (standard library only).

Steps, in order:

1. Unicode NFKC normalisation, HTML-entity unescaping, lower-casing.
2. Removal of HTML tags, URLs and e-mail addresses.
3. Contraction expansion (``didn't`` -> ``did not``) so negations are visible.
4. Collapsing of elongated words (``soooo`` -> ``soo``).
5. Tokenisation into words plus ``!`` / ``?`` (kept as weak sentiment cues).
6. Negation marking: tokens following a negation word are prefixed with
   ``not_`` until the end of the clause, at most :data:`NEGATION_SCOPE` tokens.

Stop words are intentionally kept: words such as "not" and "no" carry
sentiment, and removing them would destroy the negation signal.
"""

from __future__ import annotations

import html
import re
import unicodedata

NEGATION_SCOPE = 3
NEGATION_PREFIX = "not_"

_NEGATION_WORDS = frozenset(
    {"not", "no", "never", "cannot", "without", "hardly", "nothing", "nobody", "none"}
)
# "but" ends a negation's scope: "not cheap but great" -> great stays positive.
_SCOPE_BREAKERS = frozenset({"but", "however", "although", "though"})

_TAG_RE = re.compile(r"<[^>]+>")
_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_REPEAT_RE = re.compile(r"(.)\1{2,}")
_TOKEN_RE = re.compile(r"[a-z0-9]+|[!?.,;:\n]")
_CLAUSE_END = frozenset({".", ",", ";", ":", "\n", "!", "?"})
_KEPT_PUNCTUATION = frozenset({"!", "?"})

# Order matters: irregular forms must be handled before the generic "n't".
_CONTRACTIONS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern), replacement)
    for pattern, replacement in (
        (r"\bcan't\b", "can not"),
        (r"\bwon't\b", "will not"),
        (r"\bshan't\b", "shall not"),
        (r"n't\b", " not"),
        (r"'re\b", " are"),
        (r"'ve\b", " have"),
        (r"'ll\b", " will"),
        (r"'m\b", " am"),
        (r"'d\b", " would"),
        (r"'s\b", ""),
    )
)


def preprocess(text: str, *, mark_negation: bool = True) -> str:
    """Return the cleaned, whitespace-tokenised form of ``text``.

    Args:
        text: raw feedback text.
        mark_negation: prefix tokens in a negation's scope with ``not_``.

    Raises:
        TypeError: if ``text`` is not a ``str``.
    """
    if not isinstance(text, str):
        raise TypeError(f"text must be str, got {type(text).__name__}")

    text = unicodedata.normalize("NFKC", text)
    text = html.unescape(text).lower()
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = _TAG_RE.sub(" ", text)
    text = _URL_RE.sub(" ", text)
    text = _EMAIL_RE.sub(" ", text)
    for pattern, replacement in _CONTRACTIONS:
        text = pattern.sub(replacement, text)
    text = _REPEAT_RE.sub(r"\1\1", text)

    tokens: list[str] = []
    remaining_scope = 0
    for token in _TOKEN_RE.findall(text):
        if token in _CLAUSE_END:
            remaining_scope = 0
            if token in _KEPT_PUNCTUATION:
                tokens.append(token)
            continue
        if token in _SCOPE_BREAKERS:
            remaining_scope = 0
            tokens.append(token)
        elif token in _NEGATION_WORDS:
            remaining_scope = NEGATION_SCOPE if mark_negation else 0
            tokens.append(token)
        elif remaining_scope > 0:
            tokens.append(NEGATION_PREFIX + token)
            remaining_scope -= 1
        else:
            tokens.append(token)
    return " ".join(tokens)
