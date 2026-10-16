# Substack captures

Paste a public Note or article link, or share its page from Safari to Capture.
The browser extension can also read the selected Substack tab using its existing
access. A refused read, challenge or incomplete body stops capture.

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-depth full --json
arena-block plan 'https://publication.substack.com/p/article-slug' --json
arena-block plan 'https://substack.com/@writer/note/c-123' -t --json
```

A Note becomes **Note by @handle**. Capture preserves the authored paragraphs,
lists, emphasis and links. A quoted Note appears under its own author;
quote controls set inclusion, depth and dates. Use `--quote-author-link source`
to link each author to the quoted post, or `plain` to leave the names unlinked.
Omitting this option keeps the existing presentation. Unavailable quotes keep a link to
the missing text. The block's source field links to the outer Note.

Article cards include the article title and author. A selected passage is labelled
an excerpt; an automatic selection or card summary is labelled a preview. These
passages remain separate from the Note's own writing. A linked video keeps its
observed title when available, or its URL.

Public articles must expose their complete freely available body. Capture reads
the title, subtitle, bylines, body and supported media. Publication and custom
domain `/p/{slug}` links use this path when the page identifies a Substack article.
An unidentified custom-domain page remains an ordinary Link. Paid, partial or
inconsistent articles stop capture.

The CLI reads the selected Note by default. Add `-t` or `--thread-expansion` to
follow a verified same-author linear Note chain,
including parents around the selected Note. Other authors are excluded.
Branches, missing replies, inconsistent identities and incomplete pagination stop
expansion. List explicit Note links in order to choose a different set of sources.

Original images use the shared media controls. Supported public article and Note
videos use the shared video renderer. When the source supplies a preview image,
videos over ten minutes use that frame. Choose `--media audio` for one original article audio file, copied without
conversion and limited to 250 MiB. Capture checks the downloaded container and
duration. External players remain links. Unsupported native players or captions
that cannot be preserved stop capture. See [support and limits](substack-parity.md).

## Retained records and compatibility

Drafts and save snapshots retain the source HTML, authors, publication labels,
observation times, media details and acquisition method. Capture time and acquisition method stay in the source record. Imported records
are checked for consistent identities and supported media; validation cannot
confirm when or how someone collected them. `--substack-capture` opens an existing
record.

New resolution applies the current title and text formatting. Opening an older
frozen save keeps its approved fields and hash. Refresh the source to compose a
new version; Capture does not rewrite an earlier submission or a published block.

Records are limited to 2 MiB, twenty explicit roots, eight quote levels and one
hundred links per Note. Reply discovery permits at most 64 pages, 8 MiB aggregate,
2,000 identities and 32 selected sources.

Compatible helpers and receivers retain the records used by the plan. Notes need
`substack-browser-records-v1`; articles and expanded threads also need
`substack-public-sources-v2`. Public article media needs
`substack-native-media-v1`. Podcast article players in Notes additionally need
`substack-note-podcast-audio-v1`; the retained record distinguishes the Note's
prose from the article and its original audio. Note attachments and article cards need
`substack-note-attachments-v1`. The helper checks support before reading or saving,
then checks the returned plan for missing source fields.
