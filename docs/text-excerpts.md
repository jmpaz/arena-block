# Text excerpts

Excerpts are native Are.na Text blocks with a source URL. An ordinary page or section link remains a Link capture unless text is supplied or its URL contains a text-fragment selection. The excerpt body and its source are separate fields; the body does not acquire a generated author line or source footer.

```sh
arena-block plan 'https://example.com/article#:~:text=First%20words,last%20words.' --json
arena-block plan 'https://example.com/article#section' --excerpt 'Exact supplied text.' --json
arena-block plan --source-url 'https://example.com/article' --excerpt-file ./passage.md --title 'My title' --json
arena-block publish 'https://example.com/article' --excerpt-file ./passage.md --to your-channel --dry-run
```

`--excerpt` and `--excerpt-file` retain manual Markdown verbatim, including lists, quotations and links. `--excerpt-format plain` instead treats Markdown punctuation as literal text. Files must contain valid UTF-8, up to 200,000 bytes; excerpt text is limited to 50,000 UTF-16 code units. Manual text requires a source URL and does not fetch the page or claim a successful live selection. Existing copied text remains distinct from any later version of its source.

For a highlight link, the complete selected passage must be found in an acquired HTML or plain-text document. The start and end terms are inclusive markers, not the whole excerpt. Their intervening text cannot be reconstructed from the URL alone. Parsing follows the [URL Fragment Text Directives](https://wicg.github.io/scroll-to-text-fragment/) delimiter and percent-decoding rules, including prefix/suffix context, encoded commas/hyphens, literal plus signs and multiple text directives. The original shared URL, including its highlight directive, remains the default source. An ordinary anchor before `:~:` is retained as the document anchor; HTTP requests omit the fragment.

`--source-url` can choose another citation URL while keeping the original highlight URL and captured document identity. `--title` changes the block title. When available, the captured page title is kept separately from that edited title. A title is not invented for an arbitrary citation override.

## Resolution and provenance

The plan retains exact selected text, UTF-16 ranges, parsed directives, the original URL, the response URL, and SHA-256 hashes of the decoded source document, its text projection, and the retained Markdown. These bind a capture to a particular source version; they do not attest authorship or promise that the live page has stayed unchanged. Multiple disjoint selections are retained in directive order, separated by a blank line. Overlapping selections require manual review.

The text projection excludes scripts, templates, embedded documents and explicitly hidden content. Selected paragraphs, lists, quotations, emphasis and safe citation links are converted to Markdown. Relative citations resolve against the actual response URL or a safe declared HTML base URL. A second text projection checks that this conversion did not add or lose selected words. The exact projected text remains in the provenance record even where Markdown changes whitespace or adds structural notation.

Matching is deliberately conservative. Missing text, ambiguous matches, unsupported document formats or encodings, access failures and exceeded limits fail explicitly. The resolver does not execute page scripts, reproduce computed CSS, or implement every browser's locale-specific matching behavior. A browser may find content that the static document reader cannot. No truncated page or start/end-marker concatenation is accepted as a complete selection, and no Link block silently substitutes for an unresolved excerpt. The user can supply the text manually instead.

Public document reads use bounded requests without browser credentials or cookies. A host confirmation or login must be completed by the user through the host's normal flow. This implementation does not bypass that flow. Automatic reads accept UTF-8 HTML or plain text, up to 2 MiB, with formatted excerpts bounded to 512 KiB, a 20-second deadline and bounded public redirects.

Publishing uses the existing durable Text creation/update path. Readback verifies the native Text class, exact planned Markdown, block title and exact chosen `source.url`. The receiver advertises `web-excerpts-v1`; older receivers are rejected before publication. Saving an already prepared plan does not fetch a newer page and silently replace its text.

## Shared interfaces and pending iOS integration

`manualExcerptPlan` creates a plan from supplied text. `excerptPlanFromDocument` resolves against an explicitly supplied document and records `provided-html` or `provided-text`; the HTTP resolver records `public-html` or `public-text`. `POST /v1/excerpt-plans` accepts the same input as `resolveExcerptPlan`; `/v1/web-plans` also recognizes highlight URLs.

The bundled core exposes `captureTextFragment(url)`, `captureExcerptPlan(inputJSON)` for manual text, and `captureExcerptDocumentPlan({input, document})` for supplied HTML/plain text. Supplied-document bridges never self-label their input as a public fetch. The Swift controller and intake UI are not connected to these functions yet. Existing CaptureUI, App and Share Extension source files remain unchanged, pending design review.

The approved iOS design must preserve these backend constraints:

- Classify the original shared/pasted URL before canonicalizing it. Browser `window.location` excludes the text-fragment directive, so it cannot recover the complete shared highlight URL.
- Keep the selected text, original selection URL and chosen source independent. Page metadata must not overwrite an explicit title or replace a retained older passage.
- Editing an automatically resolved body makes the new body manual. Do not retain the old verified-selection label; the schema rejects a changed body with its old Markdown hash. The original capture can remain in draft history as a separate version.
- Freeze the exact plan before queueing. A later source read, account change, preview response or resumed intake must not replace submitted text or its source.
- When resolution fails, offer the normal host/manual route without suggesting that missing text was acquired. A pure URL plan rejects a highlight selection until it has been resolved.

These are data and fidelity requirements, not a proposed screen layout. Intake redesign remains subject to screenshots and user review.
