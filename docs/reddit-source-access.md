# Reddit source access

The CLI and iOS app read Reddit links through the shared HTTP provider. A share link resolves to its post or comment through a HEAD request with a redirect limit. Safari Share passes along the page URL. The provider checks Reddit's public JSON before building a block.

A post needs an ID, title, author, date, permalink and body field. The body can be empty. A gallery also needs its entries in order, with media URLs, and keeps captions when present. Native video needs a stream with audio, or a silent stream when Reddit reports `has_audio: false`. A cross-post needs its parent record with a matching ID. When required media or parent data is missing, capture stops. Reading a post uses the post listing, without the comment tree.

A comment capture includes the comment's text and the parent post's title, without the rest of the discussion or the parent's attachments.

When Reddit answers with HTTP 401, 403, 429 or 503, the read stops. The provider reads only the live source. Archives can miss later edits and removals, so it skips them.

## Refused requests

When Reddit refuses a request, the provider has no post record to work from. A title, preview image, embed or link falls short of the post's text, ordered media and parent data.

Reddit's [Data API documentation](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) requires registered OAuth access. Another service could stand in for it only by supplying a complete record with IDs, media and parent data. VxReddit and Rxddit serve embed previews with partial parent and media data, so they can't.

Records saved by earlier versions still open, as covered in [saved page records](reddit-public-page.md).
