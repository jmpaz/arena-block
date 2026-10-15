# Substack captures

Arena Block reads public Note and article permalinks through the shared CLI,
browser, native and receiver paths:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-depth full --json
arena-block plan 'https://publication.substack.com/p/article-slug' --json
arena-block plan 'https://substack.com/@writer/note/c-123' --thread-expansion on --json
```

Note URLs read public HTML without credentials. **Read Substack tab** in the
extension uses the invoked tab's existing scripting access. Safari Share passes
the selected page to Capture. A refused read, challenge or incomplete body stops
capture.

Public articles must expose a complete freely available body. The provider checks
article identity, publication, authors, audience and time, and retains the authored
HTML. Publication and custom-domain `/p/{slug}` URLs use the public article
contract. Unidentified custom-domain pages remain exact ordinary Links. Paid,
partial or inconsistent article records stop; selected excerpts remain excerpts.

Quoted Notes are read from their own permalink, keeping the outer preview and
separate author. Quote controls set inclusion and depth. Missing, cyclic or
limited quotes retain an explicit boundary. Article restack cards remain
unsupported.

`--thread-expansion on` follows a verified same-author linear Note chain,
including ancestors around the selected Note. Other authors are excluded.
Branches, missing replies, inconsistent identities and incomplete pagination stop
expansion. Use explicit Note permalinks in order to select another source set.

Observed original images use shared media selection and rendering. Complete public
article video and audio require source-bound upload metadata. Videos over ten
minutes use an observed Frame; shorter videos use the shared video path. Choose
`--media audio` for one original audio attachment, copied without conversion and
bounded to 250 MiB. Duration and actual media container are checked. External
players remain links. Note-native media, inline article players and article restack
cards remain unsupported. See [capture support](substack-parity.md) for limits.

Retained records carry authored HTML, identities, authors, publication labels,
observation times and acquisition method through drafts and frozen submissions.
Imported observations are declarations rather than proof of origin. Optional
`--substack-capture` imports use the same schema; files are not required for normal
URL acquisition or Safari Share.

Records are bounded to 2 MiB, twenty explicit roots, eight quote levels and one
hundred links per Note. Reply discovery permits at most 64 pages, 8 MiB aggregate,
2,000 identities and 32 selected sources. Plans require
`substack-browser-records-v1`; article and thread evidence additionally requires
`substack-public-sources-v2`. Public article media additionally requires
`substack-native-media-v1`. Helpers reject stripped evidence.
