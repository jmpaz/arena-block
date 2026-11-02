# Comment parent context

HN and Lobste.rs comment captures can include their direct ancestor chain. The selected comment remains the block's source/permalink, title author and date. This does not expand replies, siblings or a submission's body. Reddit has no new parent-context behavior.

Previously HN walked ancestors only to discover the story title; Lobste.rs read the selected comment and story metadata. Neither rendered parent comments. Existing quoted-post controls remain independent.

```
arena-block plan 'https://news.ycombinator.com/item?id=50341020' --parent-depth 2 --parent-style flat --json
arena-block plan 'https://lobste.rs/c/uyjo8l' --parent-depth full --parent-style quote --json
```

`--parent-depth` accepts 0–8 or `full` (at most eight). Default zero keeps the selected-item block body unchanged. `--parent-style flat` (default) labels each entry with its username in inline code, a soft line break, its body, and a blank-line-separated horizontal rule between entries. `quote` uses exactly the existing nested quote layout, credit/date/link policy and escaping. The oldest included ancestor appears first, then successive replies, then the selected comment. In quote mode each earlier level nests inside the later one, while selected writing stays outside the quotes, as with Twitter.

The iOS preview offers **Parent depth** and **Parent presentation** beside the existing quote controls for these sources. Choices persist in the draft and frozen submission, retain title/description edits, and recompose retained evidence. Existing drafts default to zero. Already submitted/saved captures stay immutable.

Evidence is stored as `source.parentContext`, with at most eight ancestors nearest-first, separate from `source.quote`. Each ancestor has its own permalink and available/deleted/unavailable status. A deleted record with a known parent can be traversed; no text or author is fabricated. A missing/inconsistent pointer or cycle ends traversal with an explicit boundary. HN retains the existing 100-hop ceiling for story discovery, without retaining more than eight comment bodies. Lobste.rs follows only exact `parent_comment` links in the same story, using the already-read story records where present and otherwise bounded individual reads. Cancellation aborts. A complete selected comment remains capturable when ancillary parent/story data is missing; a missing/deleted selected comment still fails. The submission is identified in metadata, never substituted for an ancestor comment. Partial chains and the eight-parent limit are labeled when the chosen scope reaches that boundary.

The source snapshot can retain up to eight parents even at depth zero so preview changes are local. The plan's policy records the chosen depth/style. `comment-parent-context-v1` guards receiver/helper compatibility; older software must be updated rather than silently stripping context or options.

Tests cover exact nesting parity with the existing quote renderer, depth-zero block stability, authorship/source identity, literal dividers, deleted/missing ancestors, cycles, bounds, cross-story references, old receiver rejection, native preview parsing, retained editing, and public HN/Lobste.rs examples. Public examples are retained in `tests/fixtures/comment-parent-public-plans.json`; a replay is evidence of rendering, not proof that a future live source remains available. No test Are.na block is required.
