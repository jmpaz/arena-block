# Substack Notes candidate

This isolated increment reads ordinary public Note URLs without credentials and
accepts bounded browser-observed records. CLI, receiver, browser and native paths
use the same composer. Source capabilities are implemented; installed components
remain unchanged. The target and remaining work are in [the parity plan](substack-parity.md).

```sh
bun run src/cli.ts plan https://substack.com/@writer/note/c-123 --quote-depth full --json
bun run src/cli.ts plan --substack-capture ./note.capture.json --media none --json
```

`--substack-capture` can be repeated, or bound to explicit Note URLs. With no
source arguments the files supply the ordered roots. Aliases with the same Note
ID deduplicate. Unrelated and duplicate capture files are errors. Raw captures
and combined imports are bounded to 2 MiB, 20 roots, eight expanded quote levels
and 100 links per Note. Unknown record fields are rejected.

The record contract is `packages/core/substack-record.ts`. `method: browser-dom`
is an assertion about how the record was prepared, not browser attestation or a
guarantee that the supplied HTML is public. Capture only the selected Note's
authored body and explicit relationships; never export the entire page, hidden
application state, feed, comments, cookies or storage. The shared DOM collector reads only the selected permalink container and follows
quoted Note URLs through credentialless public HTML. Browser invocation uses an
already granted scripting API and activeTab; it never requests a grant. Safari
uses its existing user-invoked preprocessing entry point. No changes are installed
by development or testing. Explicit imported records remain declarations of their
source method and completeness, not browser attestation.

## Fidelity

- The root must have `body.status: complete`. `preview` and `unavailable` roots
  stop planning. An embedded card's shortened words are not the full Note.
- A quoted Note is an independent author and URL. Preserve its `previewHtml`
  from the outer card; populate `expanded` only after reading the quoted Note's
  own page. Incomplete or missing expansion renders an unavailable quote boundary;
  the preview remains in the source record, without becoming complete prose.
- Quoted article selections use a linked article with `excerptHtml` and
  `excerptAuthor`. They are visibly labelled as selected excerpts. They never
  populate the composer's full `article` body.
- `links` distinguish ordinary links, linked articles, images, video and audio,
  plus `linked`, `preview` and `attachment` roles. An attachment is retained as a
  labelled source link with “original not acquired”. Preview images are not
  originals. Verified original image references participate in the common media selection and
  acquisition path. Linked/preview media remain links. Unsupported player and media
  surfaces stop; no unseen video/audio bytes are claimed as viewed.
- Keep publication timestamps exactly as displayed in `publishedLabel` when no
  timezone is known; no UTC timestamp is inferred. Observation time is UTC.
- Source Note URLs lose query tracking and fragments for identity. Linked URLs,
  including selected-quote parameters, stay intact. HTTPS source links are data,
  never fetch instructions. The converter removes scripts and unsafe HTML links.
- Plans retain the full imported capture, normalized authors and quote objects;
  body Markdown includes source links at each boundary. The existing quote policy
  still controls inclusion and depth; inspection must check its resulting coverage.

Publication clients and helper resolution require `substack-browser-records-v1`,
including for nested Substack quotes. The isolated receiver advertises and retains
this contract, while older installed receivers must stop before submission.
Browser/editor/background-job and native draft/submission/intake retain records.
Missing depth-limited quotes can acquire public descendants without changing the
root body, preview or original observation. The original depth-limit annotation
stays in the record alongside new descendants with their own acquisition evidence.
Strip guards permit only that additive hydration, never changed original fields.

The requested Note is a text-only root quoting a full Note with an external video
link. Full articles, Notes reply expansion and additional native video/audio types
remain separate parity work. This increment does not claim general Substack parity.

## Why Notes and articles need separate acquisition

[Substack describes Notes](https://support.substack.com/hc/en-us/articles/14564821756308-Getting-started-on-Substack-Notes)
as public short-form posts that may include links, images, video and other posts
or Notes. A [restack](https://support.substack.com/hc/en-us/articles/14671398684308-What-is-a-restack-on-Substack-Notes)
may add commentary, share a Note unchanged, or quote a selected article passage.
The original author and the person restacking therefore cannot be collapsed.

The supported no-key source surfaces are the public page and the
[share-menu embed code](https://support.substack.com/hc/en-us/articles/25665267911572-How-do-I-embed-Substack-posts-or-notes-on-a-website).
Embeds can be previews; their HTML must not be treated as proven complete prose.
The documented [publication RSS feed](https://support.substack.com/hc/en-us/articles/360038239391-Is-there-an-RSS-feed-for-my-publication)
is `/feed` on a publication. This documentation does not establish a Notes feed
or a general supported Notes read API. Article URLs remain ordinary Link captures
through the existing URL path; full article acquisition is outside this candidate.
No paywall or access-control bypass is included.
