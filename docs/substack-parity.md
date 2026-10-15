# Substack capture support

| Surface | Support |
|---|---|
| Public Note permalinks | Credentialless HTML acquisition; the selected body must be complete. |
| Browser and Safari intake | The invoked page reader shares the extractor and retained record schema. |
| Public articles | Complete freely public article bodies, including custom-domain discovery, validated by identity, publication, audience, authors and time. Unidentified custom-domain pages remain exact ordinary Links. |
| Quotes and restacks | Standalone Note acquisition with separate authors, retained previews, depth and cycle boundaries. Article cards retain independent authors, preview text and selected excerpts without claiming the complete article. |
| Reply expansion | Explicit `threadExpansion: on` selects a verified same-author linear Note chain. Other authors are excluded; branches or incomplete coverage stop expansion. This does not capture an entire conversation tree. |
| Rich text | Authored HTML is retained; Markdown links resolve against the containing source. |
| Original images | Observed Substack media URLs use shared selection, ordering, acquisition and rendering. |
| Ordered sources and extras | Explicit roots preserve order and deduplicate by Note ID. Media-only extras use the common composer. |
| Publication time | Explicit-offset timestamps are retained. Offset-free display times remain labels. |
| Drafts and saves | Browser and native drafts, frozen submissions, helper fallback and receiver plans retain source records. |
| Public article video/audio | Complete public uploads bound to the article and publication. Long video uses an observed Frame; video composition is limited to ten minutes. One original audio attachment is copied without conversion, bounded to 250 MiB, with container and duration checks. |
| Native Note video | Transcoded upload metadata must match the Note and its author. Nested quote media is checked against the root retained capture tree. |
| Inline article video | Explicit upload placeholders require complete article/publication-bound metadata; captions that cannot be preserved stop capture. |
| Other players | Unsupported players stop capture. External linked players remain labelled links. |

A complete root and an embedded preview have different roles. Quote hydration
reads the quoted Note's own page and keeps its separately observed body alongside
the original preview. Missing or refused sources retain their boundary rather
than substituting preview text.

Public reads depend on source availability. Identity disagreements, challenges,
collapsed bodies, partial or paid articles and unsupported media produce explicit
failures. Imported observations remain declarations: validation checks their
shape, bounds and relationships without authenticating the claimed observation.

Article acquisition uses `/api/v1/posts/{slug}`. Note chain discovery uses
`/api/v1/reader/comment/{id}` and `/replies`, validating ancestor prefixes, stable
user IDs, branch pagination and reported reply coverage. Reads omit credentials
and reject changed endpoints. Each response is bounded to 2 MiB; thread discovery
permits at most 64 pages, 8 MiB aggregate, 2,000 identities and 32 selected sources.
HTML redirects remain within the same HTTPS Note ID and stop after three hops.

Notes require `substack-browser-records-v1`. Article and thread provenance also
requires `substack-public-sources-v2`. Public article media additionally requires
`substack-native-media-v1`. Note attachments and article cards also require
`substack-note-attachments-v1`. Helpers check capability and returned plan
evidence before forwarding a save. Capability in source does not establish that
an installed receiver supports it. Physical Safari and device acceptance remains
separate from fixture and JavaScriptCore checks.

Inline video discovery reads at most 32 placeholders and 4 MiB of metadata within
60 seconds. Original media duration, dimensions and source URL must agree with
the retained complete source record before acquisition.
