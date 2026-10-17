# Substack source checks

The deterministic suite reads selected responses from real public Notes. It checks complete authored text, each quoted Note, author identity, link destinations, attachment identity and source order. It also checks the composed Markdown. A root Note with an unavailable quote fails the full-content check, even when ordinary capture can present that boundary to the user.

Run the deterministic checks without network access:

```sh
bun test tests/substack-live-contract.test.ts
```

The same suite sends the fixtures through the shared resolver used by the helper, the serialized Safari/browser page reader, and the checked-in native JavaScript bundle. Run `bun run build:ios-core` after changing shared source code before testing the bundled resolver. These checks do not open the app or submit a save.

## Real cases

| Root Note | Checked content and distinctions |
| --- | --- |
| `@norvidstudies` c-360829302 | Complete outer prose and Lam c-359890078, including the last paragraph. The YouTube URL remains a linked video, with no acquired audio or video. |
| `@norvidstudies` c-362104813 | Explicitly empty authored prose and the exact original 1448 by 1086 image. The camera glyph is not authored text. |
| `@joodaloop` c-347044458 | Full writing, original image, separate Colly preview and complete c-346876542 quote. The shortened displayed URL and full destination agree. |
| `@joodaloop` c-348712218 | Lucy Ives URL and prose, then complete c-347044458 and c-346876542 quotes. Both original images remain in source order. |
| `@joodaloop` c-360337718 | Complete density/grid prose, authored `http://nicochilla.com`, c-357819575 quote and five original images across the two Notes. |
| `@joodaloop` c-346876542 | A plain complete Note, with no quote or media. |
| `@substack` c-359359118 | Rob Stephenson prose and native video upload 9681d26c-5e44-4f6e-bd53-679694ab6da6. Its poster remains separate from the original video. |
| `@oatmilkallison` c-337896966 | Own prose and selected SOFSET article passage with its original paragraph range and byline. This is an excerpt, not the full article. |
| `@evadmartain` c-311363713 | Own “AUDIO GRAM” text and podcast article preview. Original audio upload a6e8b591-be53-465a-9d43-1615c6594f26 has Hamish McKenzie's independent byline. It is a podcast article player inside a Note. |
| `@laurelpantin` c-345777657 | Retained complete outer Note and separate quoted c-345770676 video, with original upload d51e3d24-74e7-46ac-8392-c666fdc163c1. |
| `@arr87` c-353698796 | Retained Arabic prose and original image, plus separate quoted c-353690182 video upload 0c12776b-e2f4-4187-aaae-230a9d7c08e4. |

Every case runs with its full URL, a tracking-query variant and the bare `substack.com/note/c-ID` alias. The alias fixture tests URL identity and cleanup; the redirect safety tests remain in `tests/substack-receiving.test.ts`. The HTTP and Lucy Ives cases also check shortened inline URL labels against full destinations.

The fixtures in `tests/fixtures/substack-contracts` contain 20 selected HTML/JSON responses. HTML keeps the selected permalink unit, its quote preview, media/player nodes and matching JSON-LD. It removes unrelated bootstrap scripts and styles. Embedded player elements remain as evidence; the tests do not load their URLs. Existing API field projections retain the fields read by the source reader.

`responses.json` records source URLs, fixture sizes and SHA-256 values, input fixture hashes, and any previously retained original-response hash and observation time. Missing original metadata is recorded as `null`. Those values are not reconstructed from a later observation. The two quoted-video cases have complete retained captures but no retained original outer HTML. Their deterministic checks start from those records, as `retained-provenance.json` states. They do not count as public-page acquisition coverage.

The negative response fixtures cover a collapsed preview, duplicate authored-body candidates, changed writing with unchanged structured evidence, and an unavailable quoted page. A separate test changes a schema-valid complete body and confirms that the expected text digest fails. HTTP 200 and a nonempty parse alone do not pass these checks.

## Manual live check

Print the URL list and request estimate without making requests:

```sh
bun scripts/check-substack-contracts.ts
```

Read only the latest reported failure and its quoted Note:

```sh
bun scripts/check-substack-contracts.ts --live --case 360337718 --max-requests 4 --output /tmp/substack-contract-live.json
```

For a deliberate broader check, omit `--case`. `--case` also accepts a comma-separated list. The default limit is 48 requests and the hard limit is 64. Requests run sequentially, at least one second apart. A response cache shares repeated quote reads within the run. Each response is limited to 2 MiB and the run to 32 MiB. The reader uses public page and metadata routes with credentials omitted. It does not download image, video or audio originals, read private channels, submit saves or create a schedule. The live command always reads actual URLs, including the two cases whose deterministic evidence starts from retained records.

The JSON report records each requested URL, status, observation time, response size and hash. A successful case includes the complete composed plan and its SHA-256, alongside the compared source fields. A failure records the message, source diagnostic and changed fields when available. Access restrictions, rate limiting and network failures stop the run. A skipped remainder appears under `unrun` and the process exits with a failure status.

| Result | Meaning |
| --- | --- |
| `source-unavailable` | A requested public response returns 404 or 410. This does not establish whether it was deleted or made private. |
| `access-restricted` | A response returns 401 or 403. No authenticated substitute is attempted. |
| `rate-limited` | A response returns 429. |
| `network` | The transport fails or times out. |
| `upstream-service` | A response returns a server error. |
| `content-drift` | Parsing succeeds, but complete source text, author, link, media or attachment fields differ. An intentional source edit can cause this result. |
| `incomplete-quote` | The selected root resolves, but an expected complete quoted body is absent. |
| `parser-contract` | Available response data fails the source reader or schema checks. The report retains the cause for review. |
| `source-shape-or-availability` | A 200 response lacks the selected source container or expected body. The response may be an unavailable page or a changed page structure; this result needs inspection. |
| `render-contract` | Complete source writing is missing or out of order in composed Markdown. |
| `request-budget` | The request or response-byte bound is reached. |

A changed response requires review before fixture updates. Compare the source text, identities and roles with the original observation. Do not replace expected values simply to restore a passing check.

## Recorded checks and boundaries

On October 16, 2026, the approved live run read c-360337718 and c-357819575 in two public HTML requests. Both returned 200, and the complete semantic comparison passed. It downloaded no media. The first sandboxed attempt could not connect and was recorded separately as a network failure. The successful first receipt contains response hashes and compared source fields; it predates complete-plan retention in the command. `tests/fixtures/substack-contracts/live-observation-20261016.json` retains its response hashes and result. The integration evidence directory retains the complete receipts. The other cases were not reread during this test increment.

Existing block [51476348](https://www.are.na/block/51476348) is a receiving witness for c-348712218, capture `57E00C7D-1A60-41CC-B749-C2C3378AEC2F`. The integration owner read its retained Lucy Ives prose and both nested quotations. This test suite does not replay that save. A saved block does not establish physical preview rendering or current source availability.

These tests check selected public Note text and attachment contracts. They do not cover every upstream shape. They do not prove physical share-sheet behavior, speaker playback, binary media quality, native Frame composition, byte-preserving audio export, public article acquisition beyond the attached podcast evidence, or a standalone native audio-upload Note. Those checks use their separate renderer and native tests. Source edits, deletion, privacy changes, network conditions and upstream page changes can still require investigation.
