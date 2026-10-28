# CLI media choices

`--media all` selects every attachment from the posts in the plan: each URL you list, posts added by thread expansion and `--extra` sources. `--media images`, `video` and `audio` filter that same set by type. A capture holds at most one original audio attachment.

Media inside a quoted post stays unselected, while the quote's text and attribution still appear. If you list a post directly, or thread expansion reaches it, its media counts as that post's own, even when another post in the plan quotes it. Each item appears once.

To find media references, including `sources[].quote.media`, read the output of `arena-block plan URL --json`. Give exact references to include media from quoted posts:

```sh
arena-block plan URL --media all --json
arena-block plan URL_A URL_B --media all --json
arena-block plan URL -t --media images --json
arena-block plan URL --media 1.1,1.2 --json
```

Giving a reference to `--media-order`, `--frame` or `--audio` also selects that item, as long as it matches the chosen media type. A saved plan keeps its media choices. These commands only plan, without saving a block.
