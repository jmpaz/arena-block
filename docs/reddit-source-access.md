# Reddit source access

The CLI and iOS app read Reddit links through the shared HTTP provider, with Safari Share passing along the page URL. A share link resolves to its post or comment through a bounded HEAD redirect, and the provider checks Reddit's public JSON before building a block.

Each kind of post needs certain fields, and capture stops when any are missing:

- a post: ID, title, author, date, permalink and body field, though the body can be empty
- a gallery: its entries in order, with media URLs; captions stay when present
- native video: a stream with audio, or a silent stream when Reddit reports `has_audio: false`
- a cross-post: its parent record, with a matching ID

Reading a post uses the post listing, without the comment tree.

A comment capture includes the comment's text and the parent post's title, without the rest of the discussion or the parent's attachments.

When Reddit answers with HTTP 401, 403, 429 or 503, the read stops. The provider reads only the live source. Archives can miss later edits and removals, so it skips them.

## Refused requests

When Reddit refuses a request, the provider has no post record to work from. A title, preview image, embed or link falls short of the post's text, ordered media and parent data.

Reddit's [Data API documentation](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) requires registered OAuth access. Another service could stand in for it only by supplying a complete record with IDs, media and parent data. VxReddit and Rxddit serve embed previews with partial parent and media data, so they can't.

Records saved by earlier versions still open, as covered in [saved page records](reddit-public-page.md).
