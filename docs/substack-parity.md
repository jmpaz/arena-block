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
| Images inside quoted Notes | Retains originals with their quoted source. Current composition selects the explicit source posts' media; it does not automatically compose quoted images. |
| Image-only Notes | Verifies empty authored text and the original images against the public Note record. Camera placeholders stay out of the saved text. |
| External link cards | Retains the observed title, URL and labelled preview separately from authored prose and quoted Notes. The public record must agree with the visible card. HTTP links remain links; Capture does not fetch their destination. |
| Multiple sources | Preserves explicit source order and deduplicates Note aliases by ID. Media extras use the common composer. |
| Publication dates | Retains explicit-offset timestamps and offset-free display labels. Quote dates use source dates; acquisition times remain in source records. |
| Drafts and saves | Retains source records in browser and native drafts, save snapshots, helper requests and receiver plans. |
| Public article video and audio | Checks that the upload belongs to the complete public article and its publication. When the source supplies a preview image, video over ten minutes uses that frame. One original audio file can be copied without conversion, up to 250 MiB. |
| Native Note video | Checks the upload against its Note and author, including videos inside quotes. |
| Inline article video | Checks the upload against its article and publication. Unsupported players or captions that cannot be preserved stop capture. |
| External players | Keeps the observed link and title when available. |

Public reads depend on source availability. Identity disagreements, challenges,
collapsed bodies, partial or paid articles and unsupported native media produce
errors. An embedded preview cannot substitute for the missing full text of a
quoted Note. Imported records are checked for consistent supplied data; validation
cannot authenticate the claimed observation.

## Implementation limits

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
