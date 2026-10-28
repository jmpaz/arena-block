# Substack support and limits

| Material | Capture behavior |
|---|---|
| Public Notes | Reads the full text from the public page. Safari Share and the browser tab produce the same record. |
| Public articles | Reads free public articles in full, including custom-domain pages marked as Substack articles. Other pages become ordinary Links. |
| Quotes and restacks | Opens each quoted Note at its own link and keeps its author apart from the outer Note. Quote options decide how much to include. A quote that failed to load keeps its link and a notice. |
| Article cards | Includes the title, the article's author and a preview or selected excerpt. |
| Reply expansion | With thread expansion on, follows a chain of Notes by the same author. Notes by other authors stay out. Branches and incomplete reply sets stop expansion. |
| Rich text | Keeps the authored HTML in the source record and converts it to Markdown. Relative links resolve against the page they appear on. |
| Shortened URL labels | Compares a shortened host and path label with the HTTPS link behind it. Labels written by the author stay as written. |
| Original images | Go through the shared media selection, ordering and rendering. |
| Images inside quoted Notes | Need selecting by hand. Each image keeps its quoted source and author. Preview images stay labeled as previews. |
| Image-only Notes | Checks the empty text and the original images against the public Note record. The camera placeholder stays out of the saved text. |
| External link cards | Keeps the card's title, URL and labeled preview apart from the Note's text and quoted Notes. The public record must match the visible card. HTTP links stay as links, unfetched. |
| Multiple sources | Keeps the listed order and merges Note aliases with the same ID. Media from `--extra` goes through the shared composer. |
| Publication dates | Keeps timestamps with offsets, and display labels without them. Quote dates come from the sources. Fetch times stay in the source records. |
| Drafts and saves | Keeps source records through browser and app drafts, saves, helper requests and receiver plans. |
| Public article video and audio | Checks that the upload belongs to the full public article and its publication. A video over ten minutes uses the preview image when one exists. Copies a single original audio file without conversion, up to 250 MiB. |
| Native Note video | Checks the upload against its Note and author. Video inside included quotes has the same selection, frame and soundtrack options as video in the outer Note. |
| Podcast audio players in Notes | Checks the card's upload, article, publication and byline against the full public article. Saves the original audio with the Note's text and credits the article's author separately. Selected excerpts stay labeled as excerpts. |
| Inline article video | Checks the upload against its article and publication. Players or captions the capture can't preserve stop capture. |
| External players | Keep their link, and their title when available. |

Public reads depend on the source staying up. Mismatched IDs, challenges, collapsed bodies, partial or paid articles and unsupported native media all produce errors. An embedded preview can't stand in for the full text of a quoted Note. Imported records get checked for consistency, but the check can't verify when or how someone collected them.

## Implementation limits

Original images, videos and checked original audio inside quotes are all selectable. A selected audio file goes in a block by itself, unconverted, without visual media or a second audio file. The video soundtrack can be Auto, Mix or a chosen video. A frame choice uses the source's poster image, which carries no audio.

Media follows source order: the outer post, then its quoted posts, then the next listed post. Quoted media gets references under the outer post, such as `1.2`. Quote depth limits both quoted text and quoted media, up to eight levels. Hiding a quote keeps its media choices for when it shows again. The app and extension pickers show who posted each quoted item.

Queued plans keep their original references and selections. Quoted media in an older plan takes a fresh read of the source. Newer plans need these capabilities on the receiving helper and daemon:

- Quoted images: `quoted-image-media-v1`
- Quoted video and audio, frame choices and saved soundtrack references: `quoted-video-audio-v1`

These choices leave the original source records unchanged.

Articles come from `/api/v1/posts/{slug}`. Note chains come from `/api/v1/reader/comment/{id}` and `/replies`, with checks on parents, user IDs, pagination and the reply counts Substack reports. Requests carry no credentials and stop if redirected to a different API endpoint. Each response can be up to 2 MiB. Thread discovery reads at most 64 pages, 8 MiB in total, 2,000 IDs and 32 selected sources. HTML redirects must keep the same HTTPS Note ID, for up to three hops.

Inline video discovery reads up to 32 placeholders and 4 MiB of metadata within 60 seconds. Before downloading, the capture checks that the media's duration, dimensions and URL match the full source record. After downloading, it checks the file's container and duration before rendering or attaching it.

[Substack captures](substack-notes.md#saved-records-and-compatibility) lists the receiver capabilities and record limits.

Native Note attachments come as images, video and article cards. A podcast article card can carry original audio. For these cards, the capture keeps the article's ID, byline, audio details and a digest of its public body, while leaving the article's full text out of the Note. It checks up to eight articles per Note tree, within sixty seconds. Queued captures from before this support keep their card-only selection. New podcast card records need `substack-note-podcast-audio-v1` on the helper and receiver.

Notes with a standalone native audio upload are untested. External audio and video players stay as links. Cards with `mediaClip`, `clipInfo` or image selection data are unsupported.
