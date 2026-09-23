# Sentiment Analysis Pipeline

Baseline pipeline that classifies customer feedback as **positive**, **neutral** or **negative**
(issue #2106). Code lives in `ai-service/app/sentiment/`; everything below is reproducible with one
command.

```powershell
cd ai-service
uv sync                                  # installs scikit-learn (dev dependency group)
uv run python -m app.sentiment.train     # trains, evaluates, rewrites reports/sentiment/metrics.json
uv run pytest tests -k sentiment
```

Training also writes `ai-service/artifacts/sentiment/model.joblib` (git-ignored; pass
`--no-save-model` to skip). Using it:

```python
from app.sentiment.model import SentimentClassifier

model = SentimentClassifier.load("artifacts/sentiment/model.joblib")
model.predict_one("Support fixed my issue in five minutes!")
# Prediction(label='positive', confidence=..., probabilities={'negative': ..., 'neutral': ..., 'positive': ...})
```

`joblib` files are pickles: only load model files you trained yourself.

## 1. Dataset

`ai-service/data/sentiment/customer_feedback.csv` — 180 labeled examples (`id,text,label,source`).

|                | negative | neutral | positive |   total |
| -------------- | -------: | ------: | -------: | ------: |
| product_review |       12 |      12 |       12 |      36 |
| app_store      |       12 |      12 |       12 |      36 |
| support_ticket |       12 |      12 |       12 |      36 |
| delivery       |       12 |      12 |       12 |      36 |
| restaurant     |       12 |      12 |       12 |      36 |
| **total**      |   **60** |  **60** |   **60** | **180** |

**Provenance.** The sample was written by hand for this task, modelled on common patterns in
product reviews, app-store reviews, support tickets, delivery feedback and restaurant reviews. It
contains no scraped, licensed or personal data, and it is small: treat the metrics below as a
baseline for the pipeline, not as a measure of real-world accuracy.

**Labeling guideline.**

- `positive` — overall satisfaction.
- `negative` — overall dissatisfaction.
- `neutral` — no clear opinion (purely factual statements, e.g. delivery dates) **or** balanced /
  mixed opinions (e.g. "great screen but the battery is disappointing").

Mixed reviews are the hardest cases by design. `load_dataset()` rejects unknown labels, empty text,
missing columns and duplicate texts (duplicates would leak between train and test).

## 2. Preprocessing

Implemented in `app/sentiment/preprocessing.py` (standard library only):

1. Unicode NFKC normalisation, HTML-entity unescaping, lower-casing.
2. Removal of HTML tags, URLs and e-mail addresses.
3. Contraction expansion (`didn't` → `did not`) so negations are visible.
4. Collapsing of elongated words (`soooo` → `soo`).
5. Tokenisation into words, keeping `!` and `?` as weak sentiment cues.
6. **Negation marking:** up to three tokens after `not`, `no`, `never`, `cannot`, `without`,
   `hardly`, `nothing`, `nobody` or `none` get a `not_` prefix, stopping at punctuation or a
   contrast word such as `but` (`"not cheap but great"` → `not not_cheap but great`).

Stop words are deliberately **not** removed: words like "not" and "no" carry sentiment.

## 3. Model

`TfidfVectorizer` (unigrams + bigrams, sublinear TF) → `LogisticRegression` (`C=10`,
`class_weight="balanced"`). Hyper-parameters are fixed, not tuned: with 180 examples a search would
overfit the validation folds.

## 4. Evaluation

Protocol: stratified 80/20 hold-out split (144 train / 36 test, seed 42) plus stratified 5-fold
cross-validation over all 180 examples. Full numbers are recorded in
`ai-service/reports/sentiment/metrics.json` (scikit-learn 1.9.1).

**Hold-out (36 examples)**

| Model                        |  Accuracy |  Macro-F1 |
| ---------------------------- | --------: | --------: |
| Majority-class baseline      |     0.333 |     0.167 |
| TF-IDF + logistic regression | **0.694** | **0.691** |

| Class    | Precision | Recall |    F1 | Support |
| -------- | --------: | -----: | ----: | ------: |
| negative |     0.579 |  0.917 | 0.710 |      12 |
| neutral  |     0.889 |  0.667 | 0.762 |      12 |
| positive |     0.750 |  0.500 | 0.600 |      12 |

Confusion matrix (rows = true label, columns = predicted):

|              | negative | neutral | positive |
| ------------ | -------: | ------: | -------: |
| **negative** |       11 |       0 |        1 |
| **neutral**  |        3 |       8 |        1 |
| **positive** |        5 |       1 |        6 |

**5-fold cross-validation:** accuracy 0.689 ± 0.067, macro-F1 0.687 ± 0.067 (folds range from 0.58
to 0.75).

## 5. Findings and limitations

- The baseline is far above the majority-class macro-F1 (0.69 vs 0.17), so the pipeline learns real
  signal even from 144 training examples.
- The largest error is _positive → negative_ (5 of 12 test positives; 6 of 12 positives are
  misclassified in total). Half of those 6 use a negation word positively ("without getting
  fidgety", "Nothing was damaged", "No complaints at all"), which a model trained on 144 examples
  cannot learn to treat as praise.
- Negation marking is a sound design but gave no measurable gain on this data (5-fold macro-F1
  0.687 with vs 0.686 without): 180 examples contain too few negated phrases to learn from.
- The hold-out set has only 12 examples per class, so one changed prediction moves accuracy by
  about 3 points; the cross-validation spread (±0.07) is the better guide to uncertainty.

**Next steps:** collect real, consented feedback and expand the dataset by at least an order of
magnitude; add a per-source breakdown once each source has enough data; then compare against a
fine-tuned transformer or an LLM zero-shot classifier via `app/providers`.
