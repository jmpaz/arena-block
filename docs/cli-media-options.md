# CLI media choices

`--media all` includes every attachment of the selected posts. That includes each requested primary URL, posts added by thread expansion and explicit `--extra` sources. `--media images`, `video` and `audio` filter the same selected-post set by type. Original audio remains limited to one supported attachment per capture.

Media encountered only through a quoted post stays unselected. Quote text and source attribution remain included. A post requested directly or reached through ordinary thread traversal contributes its own media even if another selected post also quotes it; the quoted copy is not selected twice.

Inspect `arena-block plan URL --json` for available media refs, including `sources[].quote.media`. Choose exact refs to include quoted assets:

```sh
arena-block plan URL --media all --json
arena-block plan URL_A URL_B --media all --json
arena-block plan URL -t --media images --json
arena-block plan URL --media 1.1,1.2 --json
```

An explicit media order, frame or soundtrack ref also names that item deliberately, subject to the chosen media type. Saved plans keep their frozen choices. None of these planning commands publishes a block.
