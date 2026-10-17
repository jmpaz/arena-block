# Retained Reddit public-page records

Ordinary Reddit links use the shared HTTP provider in CLI and iOS. Safari Share
supplies the page URL. When Reddit refuses the request, the provider stops. In iOS, Capture offers
**Use original link**. See [source access](reddit-source-access.md) for current limits.

Existing `arena-block/reddit-public-page-capture` records can be opened in drafts,
recomposed into plans and sent to compatible receivers. They retain the captured
HTML, author, source date, post or comment identity and supported image references.
Preview references remain labelled as previews. Validation checks the supplied
identities, bounds and media; it cannot confirm when or how someone collected the
data, or whether the source is currently available.

A selected comment record contains its own writing and media with the parent post
title. It excludes parent attachments and the surrounding discussion. These records
support text and link posts, selected comments and observed PNG, JPEG and WebP
images. They do not provide complete native video, galleries, animation or
cross-posts. A combined media/cross-post error cannot identify a post's actual type.

Receivers retain `reddit-browser-records-v1` and `reddit-public-page-records-v1` so
existing drafts and save snapshots keep their source fields.
