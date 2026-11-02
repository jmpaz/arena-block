# CLI media choices

`--media all` selects every attachment from the posts in the plan: each listed URL, posts added by thread expansion and `--extra` sources. `--media images`, `video` and `audio` filter that same set by type. A capture holds at most one original audio attachment.

Media inside a quoted post stays unselected, while the quote's text and attribution still appear. A post listed directly, or reached through thread expansion, contributes its media as its own, even when another post in the plan quotes it. Each item appears once.

`--media all+quotes` also includes attachments from acquired quotes within the chosen quote depth. It keeps each attachment with its original source and does not discover unrelated quoted threads.

`arena-block plan URL --json` prints the available media references, including `sources[].quote.media`. Exact references select media from quoted posts:

```sh
arena-block plan URL --media all --json
arena-block plan URL_A URL_B --media all --json
arena-block plan URL -t --media images --json
arena-block plan URL --media 1.1,1.2 --json
```

A reference given to `--media-order`, `--video`, `--frame` or `--audio` also selects that item, as long as it matches the chosen media type. A saved plan keeps its media choices. These commands only plan, without saving a block.

New mosaics default to **Balanced**. It keeps an existing compact arrangement when every tile has a reasonable share of the picture. For uneven arrangements, it compares rows and columns that retain every selected item, preserve aspect ratios and meet the existing tile-size limits. Moving video gets a modest area preference, so it can remain visible without always becoming the largest tile. Explicit media orders and selected quote media use rows to keep their reading order.

Choose an alternative with `--mosaic-layout balanced|source-order|compact`. **Source order** always arranges contiguous items in rows, read left to right and top to bottom. **Compact** uses the previous arrangement strategy, including its tile-size fallback. The app and browser editor offer the same three choices and a still preview; videos appear as posters. This preview uses reported source dimensions, so decoded media can differ. Check the rendered output for motion and small text.

An editor shows **Current layout** until you make an explicit choice. This lets you apply Balanced to an older retained plan as well as choose another arrangement.

```sh
arena-block plan URL --media all --mosaic-layout source-order --json
arena-block render --plan ./plan.json --mosaic-layout compact -o ./comparison.mp4
```

With `--plan`, an explicit mosaic choice derives a new plan in memory for rendering or publishing. It preserves the retained writing, source snapshots, selection, frame choices and soundtrack, and leaves the original file untouched. Omit the option to use the saved layout and hash unchanged. No automatic migration changes existing saved plans.
