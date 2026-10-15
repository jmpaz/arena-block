# Reddit source access

Ordinary Reddit URLs resolve through the shared HTTP provider used by CLI and iOS. A bounded HEAD redirect resolves a share link to its canonical post/comment identity. A usable public JSON response is validated before composition. No developer key is requested by this path. Safari Share sends the URL to this provider without reading a Reddit browser session.

Complete records preserve the outer post title, body Markdown, author, timestamp and canonical URL. Ordered galleries retain captions and observed media URLs. Native video uses an observed HLS stream to preserve audio, or an explicitly silent fallback only when the source says `has_audio: false`. Cross-posts retain their parent as a bounded quote with its own identity/author/date; a declared parent without its record, or a mismatched parent, stops the capture. Missing gallery/video metadata also stops acquisition. The provider does not repair missing originals from bot-facing embed HTML.

HTTP 401, 403 and 429 are terminal. No cookie copying, user-agent impersonation, alternate host, browser reader or proxy is attempted after a refusal. The pre-existing bounded archive fallback applies only to HTTP 503, not a refusal. An archive snapshot can be stale or absent; it does not establish current source availability. A removed or filtered archived snapshot is reported as such rather than as a current deletion claim.

## Neovim receiving case, October 15, 2026

`https://www.reddit.com/r/neovim/s/jNsGjBVn9A` returned a normal redirect to `https://www.reddit.com/r/neovim/comments/1x6nuin/whatsappnvim_handwritten_code_with_zero_ai/`. One honest credentialless JSON read returned HTTP 403. A separate feasibility lookup of the documented Arctic Shift ID endpoint returned HTTP 200 with `{"data":[]}`. No complete structured post/media/cross-post record was obtained. The previous combined unsupported-media/cross-post error is not proof that this post is a cross-post.

The prior successful Chrome and WebKit examples were browser acquisitions. They demonstrate record/composer parity, not current direct HTTP availability. The earlier body-image fixture is also regression evidence, not a fresh live-source check.

## Alternatives checked

The existing X provider consumes an attributed structured response from FxTwitter, then uses the shared composer/renderer. [FxEmbed's API documentation](https://docs.fxembed.com/api/introduction/) does not document a Reddit equivalent. A renderer cannot supply a missing source record.

[Arctic Shift](https://github.com/ArthurHeitmann/arctic_shift/blob/master/api/README.md) documents key-free archive IDs and comment relationships. It has no record for this receiving post. Its retained observations do not guarantee current text, edits or availability.

[VxReddit](https://github.com/dylanpdx/vxReddit) and [Rxddit/FixReddit](https://github.com/MinnDevelopment/fxreddit) document embeds rather than a complete raw-record API. Inspected contracts do not export the full parent identity/date/author chain and verified media variants required here. No bot impersonation was used. Reddit's [official Embeds](https://support.reddithelp.com/hc/en-us/articles/360043033532-How-do-I-embed-a-Reddit-post-or-comment-in-an-article-or-other-publication) provides a display widget, and its RSS wiki is unmaintained; neither supplies a qualified full capture contract.

Reddit's current [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) requires registered OAuth. No integration or access approval has been created. The remaining external dependency is either approved API access or a permitted public intermediary with a verified complete structured contract. No candidate meeting that requirement has been found among the sources checked; this does not establish that every possible source is unavailable.

Existing retained record compatibility remains described in [public-page records](reddit-public-page.md). It is not offered as a manual fallback for ordinary URL acquisition.
