# CLI media choices

`--media all` selects every attachment from the posts in the plan: each listed URL, posts added by thread expansion and `--extra` sources. `--media images`, `video` and `audio` filter that same set by type. A capture holds at most one original audio attachment.

Media inside a quoted post stays unselected, while the quote's text and attribution still appear. A post listed directly, or reached through thread expansion, contributes its media as its own, even when another post in the plan quotes it. Each item appears once.

`arena-block plan URL --json` prints the available media references, including `sources[].quote.media`. Exact references select media from quoted posts:

```sh
arena-block plan URL --media all --json
arena-block plan URL_A URL_B --media all --json
arena-block plan URL -t --media images --json
arena-block plan URL --media 1.1,1.2 --json
```

A reference given to `--media-order`, `--frame` or `--audio` also selects that item, as long as it matches the chosen media type. A saved plan keeps its media choices. These commands only plan, without saving a block.
