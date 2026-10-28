# Substack captures

The CLI and iOS app take public Note and article links, and the iOS app also receives pages shared from Safari. The browser extension can read the open Substack tab with the access it already has. If Substack refuses the read, shows a challenge or returns a partial body, capture stops.

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-depth full --json
arena-block plan 'https://publication.substack.com/p/article-slug' --json
arena-block plan 'https://substack.com/@writer/note/c-123' -t --json
```

A Note gets the title **Note by @handle**. The capture keeps the Note's paragraphs, lists, emphasis and links. A quoted Note appears under its own author, and the quote options set how many levels to include and whether to show dates. `--quote-author-link source` links each author to the quoted post, and `plain` shows the name alone. Without the option, Substack's usual style applies. A quote that failed to load keeps a link to its Note. The block's source field links to the outer Note.

An article card shows the article's title and author. A passage chosen by the Note's author carries the label "excerpt". An automatic selection or card summary carries the label "preview". Both stay apart from the Note's own text. A linked video keeps its title when Substack provides one, or its URL otherwise.

For an article, Substack has to serve the whole free body. The capture reads the title, subtitle, bylines, body and supported media. Links of the form `/p/{slug}` on a publication or custom domain go through this path when the page identifies itself as a Substack article. A custom-domain page without that marker becomes an ordinary Link. Paid, partial or inconsistent articles stop capture.

By default the CLI reads only the selected Note. Add `-t` or `--thread-expansion` to follow a chain of Notes by the same author, including the Notes before the selected one. Notes by other authors stay out of the chain. Branches, missing replies, mismatched IDs and incomplete pages stop expansion. A list of Note links captures exactly those Notes, in order.

Original images use the usual media options. Supported video from public articles and Notes goes through the shared video renderer. For a video over ten minutes, the renderer uses the preview image when Substack provides one. `--media audio` copies an article's original audio file without conversion, up to 250 MiB. The capture checks the downloaded file's container and duration. External players stay as links. Native players, or captions the capture can't preserve, stop capture. [Support and limits](substack-parity.md) has the details.

## Saved records and compatibility

Drafts and saves keep the source HTML, authors, publication labels, fetch times, media details and how each source was fetched. When importing a record, the CLI checks that its IDs agree and its media is supported. It can't confirm when or how someone collected the record. `--substack-capture` opens a saved record.

Reading a source again applies the current title and text formatting. Opening an older save keeps its approved fields and hash. Refreshing the source makes a new version. Earlier submissions and published blocks stay as they were.

Each record can be up to 2 MiB, with up to twenty listed Notes, eight quote levels and one hundred links per Note. Reply discovery reads at most 64 pages, 8 MiB in total, 2,000 IDs and 32 selected sources.

Helpers and receivers need support for the records a plan uses:

- Notes: `substack-browser-records-v1`
- Articles and expanded threads: `substack-public-sources-v2` as well
- Public article media: `substack-native-media-v1`
- Podcast article players in Notes: `substack-note-podcast-audio-v1` as well. The record keeps the Note's text apart from the article and its audio.
- Note attachments and article cards: `substack-note-attachments-v1`

The helper checks support before reading or saving, then checks the returned plan for missing source fields.
