# Saved Reddit page records

The CLI and iOS app read ordinary Reddit links through the shared HTTP provider. Safari Share passes along the page URL. When Reddit refuses a request, capture stops, and the iOS app offers **Use original link**. See [source access](reddit-source-access.md).

Earlier versions saved Reddit pages as `arena-block/reddit-public-page-capture` records. Drafts can still open these records, build plans from them and send them to compatible receivers. Each record holds the page HTML, author, date, post or comment ID and supported image references, with preview images labeled as previews. Validation checks the IDs, size limits and media in a record. It can't confirm when or how someone collected the record, or whether the post is still up.

A comment record holds the comment's text and media, plus the parent post's title. Records cover text posts, link posts, comments and PNG, JPEG and WebP images, without video, galleries, animations or cross-posts.

Receivers keep supporting `reddit-browser-records-v1` and `reddit-public-page-records-v1`, so existing drafts and saves keep their source fields.
