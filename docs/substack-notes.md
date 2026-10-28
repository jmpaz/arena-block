# Substack captures

The CLI and iOS app take public Note and article links, and the iOS app also receives pages shared from Safari. The browser extension can read the open Substack tab with the access it already has. If Substack refuses the read, shows a challenge or returns a partial body, capture stops.

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-depth full --json
arena-block plan 'https://publication.substack.com/p/article-slug' --json
arena-block plan 'https://substack.com/@writer/note/c-123' -t --json
```

A Note gets the title **Note by @handle**, keeping its paragraphs, lists, emphasis and links; the block's source field links to the outer Note. A quoted Note appears under its own author, with the quote options setting how many levels to include and whether to show dates. A quote that failed to load keeps a link to its Note.

`--quote-author-link source` links each author to the quoted post, and `plain` shows the name alone; without the option, Substack's usual style applies.

An article card shows the article's title and author, with a passage chosen by the Note's author labeled "excerpt" and an automatic selection or card summary labeled "preview"; both stay apart from the Note's own text. A linked video keeps its title when Substack provides one, or its URL otherwise.

For an article, the capture reads the title, subtitle, bylines, full free body and supported media; paid, partial or inconsistent articles stop capture. Links of the form `/p/{slug}` on a publication or custom domain go through this path when the page identifies itself as a Substack article, and other custom-domain pages become ordinary Links.

By default the CLI reads only the selected Note. `-t` follows the chain of Notes by the same author, before and after the selected one; Notes by other authors stay out, and branches, missing replies, mismatched IDs or incomplete pages stop expansion. A list of Note links captures exactly those Notes, in order.

Original images use the usual media options, and supported video from public articles and Notes goes through the shared video renderer; a video over ten minutes becomes its preview image when Substack provides one. `--media audio` copies an article's original audio file without conversion, up to 250 MiB, after checking its container and duration.

External players stay as links, while native players or captions the capture can't preserve stop capture. [Support and limits](substack-parity.md) has the details.

## Saved records and compatibility

Drafts and saves keep the source HTML, authors, publication labels, fetch times, media details and how each source was fetched. `--substack-capture` opens a saved record, checking that its IDs agree and its media is supported; the check can't confirm when or how someone collected it.

Opening an older save keeps its approved fields and hash. Reading the source again makes a new version with the current title and text formatting, and leaves earlier submissions and published blocks as they were.

Each record can be up to 2 MiB, with up to twenty listed Notes, eight quote levels and one hundred links per Note. Reply discovery reads at most 64 pages, 8 MiB in total, 2,000 IDs and 32 selected sources.

Helpers and receivers need support for the records a plan uses:

- Notes: `substack-browser-records-v1`
- Articles and expanded threads: `substack-public-sources-v2` as well
- Public article media: `substack-native-media-v1`
- Podcast article players in Notes: `substack-note-podcast-audio-v1` as well. The record keeps the Note's text apart from the article and its audio.
- Note attachments and article cards: `substack-note-attachments-v1`

The helper checks support before reading or saving, then checks the returned plan for missing source fields.
