# Substack Notes

Arena Block reads public Note permalinks and composes them through the shared CLI,
browser, native and receiver paths:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-depth full --json
arena-block plan --substack-capture ./note.capture.json --media none --json
```

The normal URL path reads public HTML without credentials. **Read Substack tab**
in the extension reads the selected Note using existing scripting and active-tab
access. Safari's Share action passes the selected page to Capture. A refused read,
challenge page or incomplete root stops capture.

Use **Export browser capture** to move a record to the CLI or native Capture's
**Import browser capture**. Repeat `--substack-capture` for ordered roots. Without
source arguments, the files supply their source URLs. Note IDs identify aliases;
unrelated or duplicate files are errors.

Records retain authored HTML, source identities, authors, publication labels,
observation times and acquisition method. Imported records can be edited, so these
fields are declarations rather than proof of their origin. Drafts, queued intake
and frozen submissions retain the records. Plans sent to a receiver require
`substack-browser-records-v1` and reject stripped source evidence.

Quoted Notes are read from their own permalink, keeping the outer preview and
separate author. The existing quote controls set inclusion and depth. Missing,
cyclic or depth-limited quotes retain an explicit boundary. Later hydration may
add separately observed descendants while preserving the original record.

Observed original images use the shared media selection and rendering path.
Linked articles, selected article excerpts and external players remain labelled
links or excerpts. Preview thumbnails do not become original attachments. See
[capture support](substack-parity.md) for the remaining source limitations.

Imports are bounded to 2 MiB, twenty roots, eight quote levels and one hundred
links per Note. Unknown fields are rejected. The record schema is
[`packages/core/substack-record.ts`](../packages/core/substack-record.ts).
