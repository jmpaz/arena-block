# Local previews and conversation drafts

Use the `render` command with a retained plan to create reading pages or a wallpaper overview. The renderer downloads the selected sources within byte/pixel limits, checks dimensions and EXIF orientation, then writes a complete output directory. A retry creates a separate directory, preserving completed files.

Reading pages use a bounded canvas and preserve source scale when possible. A source larger than the canvas returns an error unless downsampling is explicitly allowed. The wallpaper layout keeps the image order in a compact overview. Review the result at its intended display size before using it for text-heavy selections.

The `thread` command saves API responses alongside normalized records. Its Markdown and HTML retain authors, dates, reply/quote relationships, media references and explicit unavailable entries. Selection records omitted posts/media in the coverage report.

When a fetched parent post is excluded, the exporter keeps its link beside the reply and marks it as excluded.

`writeThreadDraft` takes the posts for the draft's text in `selectedIds`, and quotes to keep as bare links in `referenceOnlyQuoteIds`; each post goes in one list or the other. The manifest records those quotes with their original URLs and any CIDs, and quote expansion carries on through the rest of the fetched posts.

For x.com, provide exact known post URLs when the returned author chain is insufficient. For Bluesky, choose `chain` or bounded `tree` traversal and configure request, depth and post limits. Returned replies can omit other branches. Read the coverage report before describing the selection.

Supply reviewed image descriptions as `{ text, basis: "pixels", evidence }`, keyed by original media URL. The evidence refers to the inspected image. Attribute source alt text separately. A missing visual review remains pending; videos remain links unless a separate review is performed.

Opening draft HTML can load its referenced public images. The acquisition step retains references without downloading those media files. To share fictional examples, use the checked-in development fixtures rather than a personal conversation capture.
