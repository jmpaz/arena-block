# Substack source checks

The deterministic suite reads saved responses from real public Notes. It checks the full text, each quoted Note, author IDs, link targets, attachment IDs and source order, then checks the composed Markdown. A root Note with a quote that failed to load fails the full-content check, even though an ordinary capture can show the gap to the user.

Run the deterministic checks offline:

```sh
bun test tests/substack-live-contract.test.ts
```

The suite runs each fixture through the shared resolver used by the helper, the serialized Safari and browser page reader, and the checked-in native JavaScript bundle. After changing shared source code, run `bun run build:ios-core` before testing the bundled resolver. These checks run outside the app and save nothing.

## Source fixtures

| Root Note | Checked content and distinctions |
| --- | --- |
| `@norvidstudies` c-360829302 | Complete outer prose and Lam c-359890078, including the last paragraph. The YouTube URL remains a linked video, with no acquired audio or video. |
| `@norvidstudies` c-362104813 | Explicitly empty authored prose and the exact original 1448 by 1086 image. The camera glyph stays out of the text. |
| `@joodaloop` c-347044458 | Full writing, original image, separate Colly preview and complete c-346876542 quote. The shortened displayed URL and full destination agree. |
| `@joodaloop` c-348712218 | Lucy Ives URL and prose, then complete c-347044458 and c-346876542 quotes. Both original images remain in source order. |
| `@joodaloop` c-360337718 | Complete density/grid prose, authored `http://nicochilla.com`, c-357819575 quote and five original images across the two Notes. |
| `@joodaloop` c-346876542 | A plain complete Note, with no quote or media. |
| `@substack` c-359359118 | Rob Stephenson prose and native video upload 9681d26c-5e44-4f6e-bd53-679694ab6da6. Its poster remains separate from the original video. |
| `@oatmilkallison` c-337896966 | Own prose and selected SOFSET article passage with its original paragraph range and byline. The capture holds an excerpt of the article. |
| `@evadmartain` c-311363713 | Own "AUDIO GRAM" text and podcast article preview. Original audio upload a6e8b591-be53-465a-9d43-1615c6594f26 has Hamish McKenzie's independent byline. It is a podcast article player inside a Note. |
| `@laurelpantin` c-345777657 | Retained complete outer Note and separate quoted c-345770676 video, with original upload d51e3d24-74e7-46ac-8392-c666fdc163c1. |
| `@arr87` c-353698796 | Retained Arabic prose and original image, plus separate quoted c-353690182 video upload 0c12776b-e2f4-4187-aaae-230a9d7c08e4. |

The suite selects all media explicitly to check attachment coverage. A fresh Auto capture selects the root Note's media. Each case runs with its full URL, a variant with tracking parameters and the bare `substack.com/note/c-ID` alias. The alias case covers URL identity and cleanup. Redirect safety has its own tests in `tests/substack-receiving.test.ts`. The HTTP and Lucy Ives cases also compare shortened inline URL labels with their full targets.

`tests/fixtures/substack-contracts` holds 20 saved HTML and JSON responses. Each HTML file keeps the Note's permalink unit, its quote preview, media and player elements and the matching JSON-LD, with unrelated bootstrap scripts and styles removed. Player elements stay as evidence, and the tests leave their URLs unloaded. API fixtures keep the fields the source reader uses.

`responses.json` records source URLs, fixture sizes and SHA-256 hashes, input fixture hashes, and the original response hash and fetch time where one was saved. Where the original metadata is missing, the entry holds `null` in place of a value rebuilt from a later fetch. The two quoted-video cases start from complete saved captures, without the original outer HTML, as `retained-provenance.json` notes. They count toward record checks, apart from public-page fetch coverage.

The negative fixtures cover a collapsed preview, duplicate body candidates, changed text alongside unchanged structured data and a quoted page that failed to load. A separate test edits a valid complete body and confirms that the expected text digest fails. A check passes only on matching content, beyond HTTP 200 and a successful parse.

## Manual live check

Print the URL list and request estimate without sending requests:

```sh
bun scripts/check-substack-contracts.ts
```

Check the density/grid Note and its quoted Note:

```sh
bun scripts/check-substack-contracts.ts --live --case 360337718 --max-requests 4 --output /tmp/substack-contract-live.json
```

For a broader check, omit `--case`, or pass a comma-separated list of cases. The default limit is 48 requests, up to a hard limit of 64. Requests run one at a time, at least a second apart, and repeated quote reads share a cache within the run. Each response can be up to 2 MiB, and the run up to 32 MiB. The reader uses public page and metadata routes without credentials. It leaves image, video and audio originals undownloaded, stays out of private channels and saves nothing. The live command always fetches the real URLs, including the two cases whose deterministic checks start from saved records.

The JSON report records each URL with its status, fetch time, response size and hash. A passing case includes the composed plan and its SHA-256, next to the compared source fields. A failing case records the message, the source diagnostic and the changed fields when available. Access restrictions, rate limits and network failures stop the run. Cases left over appear under `unrun`, and the process exits with a failure status.

| Result | Meaning |
| --- | --- |
| `source-unavailable` | A requested public response returns 404 or 410. The source may have been deleted or made private. |
| `access-restricted` | A response returns 401 or 403. The check stops there, without signing in. |
| `rate-limited` | A response returns 429. |
| `network` | The transport fails or times out. |
| `upstream-service` | A response returns a server error. |
| `content-drift` | Parsing succeeds, but complete source text, author, link, media or attachment fields differ. An intentional source edit can cause this result. |
| `incomplete-quote` | The selected root resolves, but an expected complete quoted body is absent. |
| `parser-contract` | Available response data fails the source reader or schema checks. The report retains the cause for review. |
| `source-shape-or-availability` | A 200 response lacks the selected source container or expected body. The response may be an unavailable page or a changed page structure; this result needs inspection. |
| `render-contract` | Complete source writing is missing or out of order in composed Markdown. |
| `request-budget` | The request or response-byte bound is reached. |

When a response changes, review it before updating fixtures. Compare the source text, IDs and roles with the original fetch. Update expected values only after confirming the source itself changed.

## Remaining checks

The fixtures cover Note text and attachment records. Check Share on a physical device, playback, media quality, native frame composition and audio export separately. A Note with a standalone native audio upload has no test case yet. Saved live results sit next to the fixtures, in `live-observation-20261016.json` and `live-observation-20261017.json`.
