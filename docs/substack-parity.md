# Substack parity target and integration plan

Josh's target is parity with Twitter and AT Protocol capture, including the
working browser/native save workflows. A file importer alone does not meet it.
The current increment closes the public Notes acquisition and record-transport
path; the remaining rows below remain implementation work, not platform claims.

## Source-grounded baseline

| Contract | Existing evidence | Substack increment and remaining work |
|---|---|---|
| Normal permalink acquisition | `providers/x.ts`, `bluesky.ts`, `delve.ts`; provider tests | Public Note HTML is read without credentials. Selected body, author, JSON-LD identity and explicit-offset time are checked. User-invoked browser/Safari DOM uses the same extractor. No imported file is required for a public Note URL. |
| Full articles | `providers/x-article.ts`, `tests/x-article.test.ts` | **Separate next increment.** Public article endpoint is source-derived and live-tested, but no complete article provider is claimed. Keep selected article excerpts distinct from full bodies; reject paywalled/partial bodies. Custom-domain identification must preserve generic URL captures. |
| Quotes/restacks | `quote-policy.ts`, `tests/quote-depth.test.ts` | Commentary and quoted authors remain separate. Full quoted Notes are acquired from their own permalink, with the embedded preview retained. Depth/cycle/unavailable boundaries and progressive shallow-to-full hydration are explicit. Article restack cards currently stop with an unsupported-source message rather than disappearing. |
| Reply edges and author-chain expansion | `providers/index.ts`, `tests/x-thread-import.test.ts`, `bluesky-op-thread.test.ts` | **Remaining.** Notes public page data exposes `ancestor_path`, parent comments and reply count. Establish and test its relationship semantics and any current public pagination endpoint before implementing same-author expansion. Ordered explicit reply permalinks already work; no inferred reply tree is claimed. |
| Ordered primaries and extras | `source-selection.ts`, `tests/multi-primary.test.ts`, `extra.test.ts` | Common core preserves order, primary precedence, source deduplication and media-only extras. Note aliases deduplicate by immutable Note ID. Twenty explicit sources and the existing bounded expanded-source limit remain. |
| Rich text and attribution | `compose.ts`, `atproto-post.ts`, `tests/atproto-facets.test.ts` | Preserve authored HTML as source evidence, normalize formatting and resolve relative links against the correct containing source. Do not invent AT Protocol DID/URI/CID/facets for Substack. |
| Image selection/order/rendering | `types.ts`, `compose.ts`, `tests/multisource-media.test.ts`, `media-acquisition.test.ts` | Observed original image URLs become ordinary stable media refs, including image-only extras. CDN preview URLs remain previews unless their actual embedded original URL is observed. Original media stays on approved Substack media hosts. Caption text and author scope must survive extraction. |
| Video/audio | `render-recipe.ts`, media acquisition/render tests | **Remaining.** Linked external players, including the requested YouTube debate, stay links. Unsupported native player/attachment types stop; no thumbnail is promoted into an acquired video. Verify publicly exposed original/HLS sources, duration/poster/alt roles, audio behavior, expiring URLs and acquisition limits before enabling those types. |
| Provenance and time | `types.ts`, `save-intent.ts`, `provenance-schema.ts` | Retain exact bounded source records, public-html/browser-dom acquisition basis, per-node observations, explicit source timestamps, and original preview boundaries. Offset-free display times remain labels. Hydration may add separately observed public descendants; it must preserve original evidence. |
| Browser draft/edit/picker/save | `extension/src/editor.ts`, `capture-job.ts`, browser save/picker tests | Record arrays survive durable drafts, edits, policy changes, stale-result guards, background jobs and helper fallback. Generic JSON import/export supports both Reddit and Notes. Existing destination locking and picker behavior remain shared. |
| Native intake/draft/save | `native-entry.ts`, Swift `CaptureSubmission`, `CapturePreparation`, `RedditBrowserIntake`; native tests | Safari preprocessing and file imports route by record schema. Account-scoped draft, queued intake, cache identity, frozen submission and preparation retain Notes records. Rebuild the shared bundle from combined source and test in JavaScriptCore. Physical Safari/file-share/device acceptance remains separate. |
| Receiver and compatibility | `service.ts`, `version.ts`, `plan-capabilities.ts`; receiving tests | Resolve/plans accept bounded Notes arrays. Helper and publication clients check `substack-browser-records-v1` and reject stripped records. Older installed receivers must stop before submission. Capability advertisement in source is not deployment. |
| Exact requested save | Private save snapshot and route tests | Prepare only channel `4622814` (context assembly), with no Inbox/default addition. Compare final content and route, live-check duplicates and account/write access immediately before any authorized save. Preserve save UUID/recovery state if a request becomes uncertain. No speculative resubmission. |

## Acquisition research and observed behavior

The user supplied [NHagar/substack_api](https://github.com/NHagar/substack_api).
Source inspected at `37b5dfd958b57ad322288925818171af70607655`:

- `substack_api/post.py` uses `GET {publication-origin}/api/v1/posts/{slug}` and
  reads `body_html`, `audience` and metadata. Its tests use mocked responses;
  they do not establish present live availability.
- `user.py` handles public profiles and renamed handles. `chat.py` implements
  subscriber-community threads using authentication. Neither file establishes
  a Notes reply API contract; there is no Notes client in the inspected source.
- Authentication/cookie export in that library is outside this increment. We
  did not install or execute the library, extract credentials or grant access.

Live credentialless Mac reads returned HTTP 200 for the requested Note, its
standalone Lam quote, and another public restack containing an image. Their
selected authored HTML is distinct from metadata/preview cards. A source-derived
article endpoint on `www.stevestewartwilliams.com`, slug `imaginary-enemies`,
returned `audience: everyone` and 42,962 characters of `body_html` on this read.
These are observed fixtures, not stability guarantees or permission to bypass
future refusals. HTTP failures, challenges, structure/identity disagreements,
unsupported media and collapsed body evidence stop or retain a truthful boundary.

## Implementation sequence

1. Finish the reviewed Note vertical path: credentialless/public and invoked-tab
   reads, progressive quote hydration, receiver retention, durable browser/native
   intake, generated-resource parity, exact requested preview and route.
2. Complete source-wide media projection with real public image/video fixtures,
   original/preview roles and existing selection/order/acquisition behavior.
3. Implement complete public articles from verified endpoint contracts, including
   titles/bylines/rich body/in-order media; preserve generic URLs and custom-domain
   discovery. Explicitly stop paywalled/partial responses.
4. Establish public Notes reply/parent/pagination contracts, then implement bounded
   same-author expansion with source evidence, scope/coverage and cancellation.
5. Review the combined implementation and run existing provider, receiver, browser,
   native, media, draft/edit/picker/save regression suites. Serialize installation
   handoff with the Arena owner. The user authorized deployment of reviewed code
   to the phone and CLI for evaluation on the same review branch as Reddit.
   The Arena owner performs installation; main merge and new access grants remain held.

The evidence frontier is real media/player and reply API behavior, custom-domain
article discovery, and installed-device acceptance. Lack of official documentation
alone does not make a public endpoint unusable. Every undocumented route requires
source-contract and live-response evidence, explicit bounds and honest failures.
