<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/mark.svg" />
  <img src="assets/mark.svg" width="32" height="32" alt="Arena Block" />
</picture>

# arena-block

Arena Block captures social posts as editable Are.na blocks.

Available as a [CLI](docs/development.md), [iOS app](ios/README.md) and [browser extension](extension/README.md).

## Development

Install Bun, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run src/cli.ts --help
```

The project includes Nix packages and optional Home Manager modules. See [development](docs/development.md) for the source layout, build commands and tests, or [UI development](docs/design.md) for editor code and fixtures.

## Plans and saves

```sh
bun run src/cli.ts plan 'https://x.com/example/status/123' --media none --json
bun run src/cli.ts plan 'https://soundcloud.com/example/track' --media audio --json
bun run src/cli.ts publish --plan ./plan.json --to your-channel --dry-run
```

During planning, the resolver reads the selected source and creates normalized posts. The composer selects text and media, formats the block, then calculates the plan hash. A saved plan includes source URLs, authors, timestamps, quote relationships and media references. Editing those fields requires a new composition and hash.

During publication, the client checks the destinations and acquires the selected media. The save journal records the attempt and any returned block ID. After checking the block and requested channel placements, the client reports the confirmed result. A lost create response leaves an uncertain attempt for inspection before another creation request.

Use `resolve`, `plan`, `publish`, `save`, `status`, `cancel` or `retry` as shown in `--help`. `publish --plan` reads a retained plan. `--dry-run` reviews routing without creating a block. The `save-intent` command records local input for a later approved save. Existing submitted attempts keep their original content, policy, destinations and UUID.

## Source providers

| Provider | Accepted sources | Acquisition |
|---|---|---|
| x.com | Post permalinks and article posts | Public FxTwitter responses |
| Bluesky | Profile post permalinks, `at://.../app.bsky.feed.post/...` | Public AT Protocol AppView responses |
| [Delvetown](https://delve.town) | Profile post permalinks, `at://.../town.delve.feed.post/...` | Delvetown AppView and repository records |
| Mastodon | Public HTTPS post permalinks | The instance's public status API |
| Reddit | Posts, comments, galleries, share links | Public JSON, public-page/browser records, bounded availability fallback |
| LessWrong, Alignment Forum, EA Forum | Post and comment permalinks | Each site's public GraphQL API |
| Substack | Public Notes and complete freely public articles | Public HTML/API or user-invoked browser records |
| TikTok, Instagram | Supported post, video and share permalinks | FxEmbed Atmosphere responses |
| SoundCloud | Public track and playlist pages | Public page data and available download metadata |
| Hacker News, Lobsters | Comment permalinks | Public comment APIs |

[Substack captures](docs/substack-notes.md) preserve authored text, original images, quoted Notes and complete freely public articles. Use `--thread-expansion on` for a verified same-author linear Note chain. Public article video and original audio use the shared media path; Note-native media, inline article players and article restack cards remain unsupported. See [capture support](docs/substack-parity.md).

Bluesky and Delvetown use separate record collections and facet vocabularies. The renderer expands a shortened URL label after checking its facet destination, preserves meaningful link labels, keeps mention wording and leaves tags as text. It checks UTF-8 ranges before generating Markdown. Plans retain the original text and record data. Refresh an older cached Bluesky source to acquire facets discarded by an older resolver.

Supported AT Protocol plans include observed record URI, CID and author DID. Before submitting them, a client checks the daemon's `atproto-post-records-v1` capability. Delvetown also requires `delve-posts-v1`. Native conversation-coverage data requires `bluesky-thread-coverage-v1`. An older receiver returns a compatibility error before submission.

Mastodon boosts resolve to the original post. Content warnings and attachment descriptions remain available in the result. Link previews stay separate from attachments. Audio and unsupported attachment types appear as links.

For x.com articles, the composer places the article Markdown in the block and uses the accompanying post text as its description. Article images remain in reading order. Embedded videos and posts remain links. Incomplete article responses produce an error.

Reddit post titles become block titles. Body Markdown and gallery captions become text content or media descriptions. Cross-posts retain the quoting post and expose the original attachments. Reddit-hosted video uses HLS for audio. Comment capture uses the selected comment and its parent title. It excludes surrounding replies and parent attachments.

When a JSON read returns HTTP 403, native Capture and the Darwin CLI can read the ordinary public page in a fresh WebKit session. This needs no Reddit developer key, login or capture-file import. HTTP 429 stops acquisition. Public-page capture supports full writing, observed PNG/JPEG/WebP images and selected comments; broader gallery/video/cross-post support requires usable JSON. Challenges and incomplete sources stop the read. See [public-page capture](docs/reddit-public-page.md) for scope and packaging. Specified temporary availability failures may use the bounded Arctic Shift fallback; archive responses can omit recent edits.

The browser extension also supports **Read Reddit tab** on an open public post or selected comment. Chrome and Firefox request optional scripting access on this action. The reader uses the page's existing session for a same-origin JSON read, stops on refusals or challenge HTML, and exports public fields without cookies or account state. **Export browser capture** writes a JSON snapshot for retained-file workflows:

```sh
arena-block plan --reddit-capture post.arena-reddit.json --media all --json
```

A matching source URL may accompany the file; otherwise the CLI uses the file's source URL. Repeat `--reddit-capture` for multiple sources. The importer checks matching identities, declared public-community fields, timestamp format and record bounds; it preserves complete selftext, supported media and selected-comment provenance. Imported records can be edited. Validation and plan hashes do not authenticate Reddit, public visibility or observation time. Plan hashes include the declared observations. A receiver must advertise `reddit-browser-records-v1` before the CLI submits such a save.

On iOS, paste the URL or share the page from **Safari → Capture**. Safari can pass a usable page-side JSON record; a denied 403 read passes the URL to the native public-page adapter. URL-only intake uses the same adapter without reusing Safari's session. Supported record files remain available through the Share extension. Retained records stay with drafts and frozen submissions. External embedded players, Giphy comment tokens, unsupported animation types and unavailable media stop a complete capture. Browser records are bounded at 2 MiB, media metadata at 100 entries, and API cross-post nesting at four parents. Imported attachments must use matching Reddit image identities or native video paths. Ordinary external post links remain text links. Public-page records additionally require the receiver's `reddit-public-page-records-v1` capability.


TikTok and Instagram carousels preserve source order. Photo mosaics omit soundtracks. Video mosaics use the selected soundtrack. Public provider access and media URLs can become unavailable, so refresh a stale plan before another acquisition attempt.

Hacker News links must identify comments. Lobsters accepts `/c/ID` and story links ending in `#c_ID`. Comment capture preserves paragraphs and formatting, uses the source URL field and records the UTC creation time in the description. Unavailable comments return an error.

For a Quick Take or Shortform entry, copy its comment permalink. A bare Shortform container has no body to capture. Use `?commentId=ID`, a comment path, or a comment hash. GreaterWrong links resolve through LessWrong's public API. The resulting plan includes the selected comment's author, date, formatting, links, quotes and image references. Embedded frames appear as links.

For a single comment URL, the default expansion follows up to six available parents. Use `--thread-expansion off` to capture only the selected comment. Use `on` to include up to eight direct replies and bounded same-author continuations. When you list several comment URLs, the result follows your order. Deleted, private and unavailable content returns an error.

Before submitting a Forum Magnum plan, the client checks the receiver for `forum-magnum-posts-v1`. You can plan and render locally without a receiver.

For SoundCloud, planning preserves track or playlist metadata. Original-download availability depends on the public source. An unavailable verified file URL remains a source link.

## Composition and media

Supply primary URLs in the required reading order. Equivalent links are included once. Each primary contributes text and root attachments. `--extra` adds supplementary media while the primary sources continue to determine the writing and authors.

Use `--media auto|none|images|video|audio|all`, or explicit media references, according to command help. Selected images form an ordered JPEG mosaic. Selected videos form an MP4 mosaic. Video framing and soundtrack choices remain explicit. During acquisition, the renderer checks source bytes, decoded pixels, media dimensions, duration and output limits before creating the final file.

The title identifies the first author. A speaker change adds that author's label. `--separator auto|always|never` controls dividers between contributions. Quote depth, dates and inclusion follow the composition policy. Each quoted post retains its own author and source information.

For Bluesky and Delvetown, thread expansion follows the returned author and reply relationships. For x.com, import an observed author chain or enter exact post links. The client accepts up to 32 posts from an observed expanded thread and up to 20 explicit links. Before submitting a plan with more than 20 posts, it checks the receiver for `expanded-source-count-32-v1`. If a provider omits replies or branches, the result describes the scope it returned.

For local image previews:

```sh
bun run src/cli.ts render --plan ./plan.json --layout reading --output-dir ./previews
bun run src/cli.ts render --plan ./plan.json --layout wallpaper --canvas 2510x4096 --output-dir ./previews
```

Reading pages preserve source scale when the image fits the configured canvas. Wallpaper mode creates an ordered overview. Dense selections may need separate reading pages. Each successful render creates a fresh directory.

## Thread drafts

```sh
bun run src/cli.ts thread 'https://bsky.app/profile/example.com/post/first' --scope chain --output-dir ./drafts
bun run src/cli.ts thread 'https://x.com/example/status/123' --manifest ./post-urls.json --output-dir ./drafts
```

A draft includes original responses, normalized posts, Markdown, HTML and a coverage report. A supplied x.com manifest lists exact known post URLs. Bluesky `chain` reads the selected post and ancestors; `tree` follows bounded replies. Configure post, request and depth limits for the intended selection. Image descriptions require pixel review, with source alt text attributed separately. See [local drafts](docs/mosaic-thread-drafts.md).

## Destinations and service

Configure a default channel with [the generic example](config.default-channel.example.json). Fallback mode uses it when no explicit destination is supplied. Always mode adds it alongside selected destinations. The client checks the account and destination permissions before creation. Legacy `remoteInbox` configuration remains accepted for migration. See [routing and saved input](docs/default-channel-provenance.md).

```sh
ARENA_BLOCK_HOST=127.0.0.1 ARENA_BLOCK_PORT=8790 bun run src/cli.ts serve
```

The service stores state under `$XDG_DATA_HOME/arena-block` or `~/.local/share/arena-block`. Configure its credential through environment references or a private configuration file. The project does not include account credentials.

The desktop `picker` command opens a loopback editor through a matching daemon. Its local session token provides access to that editor. Channel browsing requires the daemon's matching channel/web-plan routes. See command help before configuring the service or enabling private MCP publication.

## Native and browser clients

The [iOS client](ios/README.md) uses SwiftUI, JavaScriptCore and native media rendering. The [browser extension](extension/README.md) uses the shared core with browser fetch/media adapters. Both preserve draft choices before Save and show confirmed placement results after verification.

In the iOS channel picker, Reset to default restores the configured default channel. Manual deselection can leave the draft without a destination. Without a configured default, Clear empties the selection.
