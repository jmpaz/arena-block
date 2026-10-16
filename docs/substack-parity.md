# Substack support and limits

| Material | Capture behavior |
|---|---|
| Public Notes | Reads the complete authored body from the public page. Safari Share and the invoked browser tab can supply the same source record. |
| Public articles | Reads complete freely public articles, including identified custom-domain pages. Unidentified pages remain ordinary Links. |
| Quotes and restacks | Opens each quoted Note at its own link and keeps its author separate from the outer Note. Quote controls determine how much to include. Unavailable quotes retain their link and missing-text notice. |
| Article cards | Includes the title, independent author and preview or selected excerpt. |
| Reply expansion | With `threadExpansion: on`, follows a verified same-author linear chain. Other authors, branches and incomplete reply sets are excluded or stop expansion. |
| Rich text | Preserves authored HTML in the source record and converts it to Markdown. Relative links resolve against their containing source. |
| Shortened URL labels | Verifies host/path abbreviations against the observed HTTPS link target when comparing complete source text. Custom authored labels remain literal. |
| Original images | Uses shared media selection, ordering and rendering. |
| Images inside quoted Notes | Fresh captures include original images from the included quote levels. Each image keeps its quoted source and author. Preview images remain previews. |
| Image-only Notes | Verifies empty authored text and the original images against the public Note record. Camera placeholders stay out of the saved text. |
| External link cards | Retains the observed title, URL and labelled preview separately from authored prose and quoted Notes. The public record must agree with the visible card. HTTP links remain links; Capture does not fetch their destination. |
| Multiple sources | Preserves explicit source order and deduplicates Note aliases by ID. Media extras use the common composer. |
| Publication dates | Retains explicit-offset timestamps and offset-free display labels. Quote dates use source dates; acquisition times remain in source records. |
| Drafts and saves | Retains source records in browser and native drafts, save snapshots, helper requests and receiver plans. |
| Public article video and audio | Checks that the upload belongs to the complete public article and its publication. When the source supplies a preview image, video over ten minutes uses that frame. One original audio file can be copied without conversion, up to 250 MiB. |
| Native Note video | Checks the upload against its Note and author. Videos inside included quotes use the same selection, framing and soundtrack controls as outer videos. |
| Podcast audio players in Notes | Checks the card's upload, article, publication and byline against the complete freely public article. Captures one original audio file with the Note's prose and independent article attribution. Selected article excerpts remain excerpts. |
| Inline article video | Checks the upload against its article and publication. Unsupported players or captions that cannot be preserved stop capture. |
| External players | Keeps the observed link and title when available. |

Public reads depend on source availability. Identity disagreements, challenges,
collapsed bodies, partial or paid articles and unsupported native media produce
errors. An embedded preview cannot substitute for the missing full text of a
quoted Note. Imported records are checked for consistent supplied data; validation
cannot authenticate the claimed observation.

## Implementation limits

Original images, videos and verified original audio are selectable inside quotes.
A selected audio file is saved alone without conversion; it cannot be mixed with
visual media or another standalone audio file. Video soundtracks use Auto, Mix or
a selected video. Frame choices use the observed poster and carry no audio.

Media follow source order: the outer post, its quoted descendants, then the next
chosen post. Quoted media have distinct references within the outer post's
namespace, such as `1.2`. Quote depth controls both writing and quoted media, up
to eight levels. Hiding a quote keeps explicit media choices for when it is shown
again. The native and browser pickers identify the quoted media's author.

Existing queued plans retain their original references and selection. Read the
source again to include quoted media in an older plan. New quoted-image plans
require `quoted-image-media-v1`; quoted video/audio selections, frame choices and
retained soundtrack references require `quoted-video-audio-v1` on the receiving
helper and daemon. Original source records remain unchanged by these choices.

Article reads use `/api/v1/posts/{slug}`. Note chain discovery uses
`/api/v1/reader/comment/{id}` and `/replies`, checking ancestors, user IDs,
pagination and reported reply coverage. Reads omit credentials and reject changed
API endpoints. Each response is limited to 2 MiB; thread discovery permits at most
64 pages, 8 MiB aggregate, 2,000 identities and 32 selected sources. HTML redirects
stay within the same HTTPS Note ID and stop after three hops.

Inline video discovery reads at most 32 placeholders and 4 MiB of metadata within
60 seconds. Before download, original media duration, dimensions and source URL
must agree with the complete source record. The downloaded file's container and
duration are checked before rendering or attachment.

Receiver capability names and retained-record limits are listed in
[Substack captures](substack-notes.md#retained-records-and-compatibility).

The observed native Note attachment contract supports images, video and article
cards. A podcast article card can expose original audio. Capture retains the
article's identity, byline, audio metadata and a digest of its verified public
body; it does not include the article's full prose in the Note. Hydration is
bounded to eight distinct articles and sixty seconds per Note tree. Old queued
card-only captures retain their existing selection. New podcast-card records
require `substack-note-podcast-audio-v1` on the helper and receiver.

A separate native audio-upload Note attachment has not been verified. External
audio and video players remain links; their URLs are not promoted to native
attachments. Cards with `mediaClip`, `clipInfo` or image-selection data remain
unsupported.
