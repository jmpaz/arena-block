# Reddit source access

CLI and iOS read ordinary Reddit links through the shared HTTP provider. A bounded
HEAD redirect resolves a share link to its post or comment. Safari Share supplies
the URL. Capture validates the returned public JSON before composing a block.

A post needs its ID, title, author, date, permalink and body field. The body can be
empty. Galleries additionally need ordered entries and observed media URLs; captions
are retained when present. Native video needs an observed stream that preserves audio, or an explicitly silent
stream when Reddit reports `has_audio: false`. A cross-post needs its parent record
with a matching identity. Missing required media or parent data stops capture.
An ordinary post read uses the post listing; it does not require the comments tree.

A selected comment includes its own writing and the parent post title. It excludes
the surrounding discussion and parent attachments.

HTTP failures, including 401, 403, 429 and 503, stop the direct read. Capture does
not automatically substitute archived post text, comments or parent titles when
the live source is unavailable. An archive may omit later edits or removal state
and cannot establish the current content of a Reddit link.

## Unavailable sources

A denied request provides no post record to render. A title, preview image, embed
or source link cannot replace the missing authored text, ordered media and parent
data. For the checked Neovim post `1x6nuin`, Reddit returned HTTP 403 and the archive
lookup returned no record. Complete capture remains unavailable for that example.

Reddit's [Data API documentation](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)
requires registered OAuth access. A future intermediary must be permitted to supply
a complete structured record with the required identity, media and parent data.
The reviewed VxReddit and Rxddit interfaces provide embed presentation with
incomplete parent and media information; they do not supply that record.

Earlier saved blocks confirm that Reddit text and comments were captured. Their
fields do not identify whether direct JSON or the former archive fallback supplied
the text. They do not establish current access for another URL.

Existing source records remain readable as described in
[retained public-page records](reddit-public-page.md).
