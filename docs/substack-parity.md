# Substack capture support

| Surface | Support |
|---|---|
| Public Note permalinks | Credentialless HTML acquisition; the selected body must be complete. |
| Browser and Safari intake | The invoked page reader shares the same extractor and record schema. |
| Quotes and restacks | Standalone Note acquisition with separate authors, retained previews, depth and cycle boundaries. Article restack cards are unsupported. |
| Rich text | Authored HTML is retained; Markdown links resolve against the containing source. |
| Original images | Observed Substack media URLs use shared selection, ordering, acquisition and rendering. |
| Ordered sources and extras | Explicit roots preserve order and deduplicate by Note ID. Media-only extras use the common composer. |
| Publication time | Explicit-offset timestamps are retained. Offset-free display times remain labels. |
| Drafts and saves | Browser and native drafts, frozen submissions, helper fallback and receiver plans retain source records. |
| Full articles | Unsupported. Article URLs continue through ordinary URL capture. Selected excerpts remain distinct from complete articles. |
| Reply expansion | Unsupported. Explicit reply permalinks can be ordered as separate sources; no reply tree or same-author chain is inferred. |
| Native video and audio | Unsupported. External players remain links; unsupported native attachments stop capture. |

A complete root and an embedded preview have different roles. Quote hydration
reads the quoted Note's own page and keeps its separately observed body alongside
the original preview. Missing or refused sources retain their boundary rather
than substituting preview text.

Public HTML is an availability-dependent source. Identity disagreements,
challenges, collapsed bodies and unsupported media produce explicit failures.
Imported observations remain declarations. The importer validates their shape,
bounds and relationships without authenticating the claimed observation.
