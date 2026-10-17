<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/mark.svg" />
  <img src="assets/mark.svg" width="32" height="32" alt="Arena Block" />
</picture>

# arena-block

Arena Block captures social posts as editable Are.na blocks. Use the [CLI](docs/development.md), [iOS app](ios/README.md) or [browser extension](extension/README.md) to review the writing, choose media and save to your channels.

## CLI

Install Bun, then run:

```sh
bun install --frozen-lockfile
bun run src/cli.ts --help
bun run src/cli.ts plan 'https://x.com/example/status/123' --media none --json
bun run src/cli.ts publish --plan ./plan.json --to your-channel --dry-run
```

`plan` reads sources and prepares the title, text, media selection and plan hash. Review that output before using `publish`. With `--dry-run`, `publish` prints the proposed save and destinations locally. Saving requires a configured daemon and account access.

Use `--help` after a command for its arguments and options. Help wraps to the terminal width, with stacked option descriptions in narrow panes. Piped help defaults to 80 columns; set `COLUMNS` for a different width. `NO_COLOR=1` produces plain text.

For local output:

```sh
arena-block render --plan ./plan.json --layout reading --output-dir ./previews
arena-block thread 'https://bsky.app/profile/example.com/post/first' --scope chain --output-dir ./drafts
```

Reading pages preserve source scale when they fit the configured canvas. Wallpaper mode creates an ordered overview. Conversation drafts retain source responses, Markdown, HTML and a coverage report. See [previews and drafts](docs/mosaic-thread-drafts.md).

## Sources

| Provider | Supported input and limits |
|---|---|
| X | Post permalinks, complete public article responses and available author threads through FxTwitter |
| Bluesky, [Delvetown](https://delve.town) | Post links or collection-specific `at://` URIs through public AppViews and records |
| Mastodon | Public HTTPS post permalinks through the instance's status API; boosts resolve to the original post |
| Reddit | Direct public post/comment JSON where available; denied requests stop capture |
| LessWrong, Alignment Forum, EA Forum | Public post and comment permalinks through each site's GraphQL API |
| Substack | Public Notes, complete freely public articles, supported original media and article cards |
| TikTok, Instagram | Supported post, video and share permalinks through FxEmbed Atmosphere |
| SoundCloud | Public tracks and playlists, with original downloads when the source exposes them |
| Hacker News, Lobsters | Selected comment permalinks through public APIs |

Substack Notes use **Note by @handle**. Quoted Notes retain their own authors. Article previews and selected excerpts receive labels separate from the Note's writing. Original article audio and supported video use the shared media controls. See [Substack captures](docs/substack-notes.md), [support limits](docs/substack-parity.md) and [fixture checks](docs/substack-contract-checks.md).

Reddit key-free acquisition remains unresolved for denied sources, including the checked Neovim post. HTTP 401, 403, 429 and 503 stop the read. Browser-assisted and manual capture are outside the acquisition workflow. Existing saved records remain readable for compatibility. See [Reddit source access](docs/reddit-source-access.md).

Instagram Reel permalinks use **Reel by @handle**. Other Instagram posts use **Post by @handle**. TikTok and Instagram carousels preserve source order. Source availability and media URLs can change; refresh a stale plan before preparing another save.

For Forum Magnum Quick Takes and Shortform entries, supply the comment permalink. A bare Shortform container has no body to capture. GreaterWrong links resolve through LessWrong. Hacker News and Lobsters inputs must also identify the selected comment.

## Text and media

Enter primary links in reading order. `--extra` adds supplementary media while the primary posts supply the writing and author labels. Explicit compositions accept up to twenty links; supported expanded threads accept up to thirty-two posts.

New CLI compositions read the supplied posts. Add `-t` to request a supported thread or author chain. The iOS editor enables thread import for new supported single-source captures and retains your choice. Expansion depends on the provider's returned relationships and available replies. See [CLI thread options](docs/cli-thread-options.md).

Fresh **Auto** captures select root-post media. Include quoted media through **All** or individual selections. Quote text, depth and dates have separate controls. Saved explicit selections remain effective. Images form a JPEG mosaic; videos form an MP4 mosaic. Poster frames and soundtracks can be selected before rendering. An available original SoundCloud or Substack audio file can be saved alone without conversion.

Use `--quote-author-link source` to link quoted authors to their posts, or `plain` for unlinked names. Omission preserves the platform's existing presentation. The [quote options](docs/cli-quote-options.md) and [client controls](docs/quoted-author-links.md) describe compatibility and saved-plan behavior.

Source URLs, authors, dates and original records remain available in the plan. Acquisition notes stay in source records. They are excluded from published writing. AT Protocol links and mentions use verified facet ranges; X article prose goes into block text, with its accompanying post text in the description. Missing or incomplete required source data returns an error.

## Saving and recovery

Before creating a block, the client checks the account and requested channel access, then records the save UUID and approved plan. After creation, it checks the block and channel placements. A lost creation response leaves an uncertain attempt for inspection.

Use `save-status` for a retained save UUID, `status` or `inspect` for a receipt, and `attempt` for an uncertain creation. Review the reported result before using `retry-save` or `resume`. Canceling stops future work while retaining completed blocks and placements. Existing submitted saves keep their approved content, selections and destinations.

Configure a [default channel](config.default-channel.example.json) as a fallback or alongside every explicit selection. See [routing and saved input](docs/default-channel-provenance.md). The daemon stores state under `$XDG_DATA_HOME/arena-block` or `~/.local/share/arena-block` and reads credentials from private configuration or environment references.

```sh
ARENA_BLOCK_HOST=127.0.0.1 ARENA_BLOCK_PORT=8790 bun run src/cli.ts serve
```

The optional local channel picker, MCP server and browser helper use the configured daemon. Helpers and receivers check plan capabilities before accepting newer source records or composition options.

## Development

```sh
bun run typecheck
bun run extension:typecheck
bun test
```

See [development](docs/development.md) for dependencies, Nix packaging and native checks, or [UI development](docs/design.md) for editors and fixtures. Native storage behavior and report limits are described in [Capture storage](docs/capture-storage.md).
