<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/mark.svg" />
  <img src="assets/mark.svg" width="32" height="32" alt="Arena Block" />
</picture>

# arena-block

Arena Block captures social posts as editable Are.na blocks.

Available as a [CLI](docs/development.md), [iOS app](ios/README.md) and [browser extension](extension/README.md).

## CLI

```sh
bun install --frozen-lockfile
bun run src/cli.ts --help
bun run src/cli.ts plan 'https://x.com/example/status/123' --media none --json
bun run src/cli.ts publish --plan ./plan.json --to your-channel --dry-run
```

`plan` reads each source, composes the block and prints its title, text, selected media and plan hash. `publish` sends a plan to the daemon, which creates the block on Are.na; with `--dry-run`, it prints the save and its destinations and stops there.

Help text wraps to the terminal width, or to 80 columns when piped; `COLUMNS` sets another width, and `NO_COLOR=1` turns off color.

```sh
arena-block render --plan ./plan.json --layout reading --output-dir ./previews
arena-block thread 'https://bsky.app/profile/example.com/post/first' --scope chain --output-dir ./drafts
```

`render` writes local image previews, either as reading pages at source scale or as a single wallpaper overview. `thread` writes a conversation draft with the source responses, Markdown, HTML and a coverage report. See [previews and drafts](docs/mosaic-thread-drafts.md).

## Sources

| Provider | Supported input |
|---|---|
| x.com | Post permalinks, public articles and author threads, read through FxTwitter |
| Bluesky, [Delvetown](https://delve.town) | Post links or `at://` post URIs, read through public AppViews |
| Mastodon | Public HTTPS post permalinks, read through the instance's status API; a boost resolves to the original post |
| Reddit\* | Public posts and comments, read as JSON |
| LessWrong, Alignment Forum, EA Forum | Post and comment permalinks, read through each site's GraphQL API |
| Substack | Public Notes, free public articles, original media and article cards |
| TikTok, Instagram | Post, video and share permalinks, read through FxEmbed Atmosphere |
| SoundCloud | Public tracks and playlists, with track audio saved as an attachment |
| Hacker News, Lobsters | Comment permalinks, read through public APIs |

A Substack Note gets the title **Note by @handle**, and each quoted Note keeps its own author. Article previews and excerpts carry labels separating them from the Note's text. See [Substack captures](docs/substack-notes.md), [support and limits](docs/substack-parity.md) and [source checks](docs/substack-contract-checks.md).

\* Reddit capture is unreliable: Reddit refuses many unauthenticated reads, and the CLI stops on HTTP 401, 403, 429 or 503. Reddit records saved by earlier versions still open. See [Reddit source access](docs/reddit-source-access.md).

An Instagram Reel gets the title **Reel by @handle**, and other Instagram posts get **Post by @handle**. TikTok and Instagram carousels keep their source order; their media URLs expire after a while, and planning again fetches fresh ones.

Forum Magnum Quick Takes and Shortform entries resolve from their comment permalinks, since a Shortform container page holds no text of its own; GreaterWrong links resolve through LessWrong. Hacker News and Lobsters links resolve to a single comment.

## Text and media

The CLI composes posts in the order given, taking the block's text and author labels from them. `--extra` adds media from another post without its text. A plan holds up to 20 listed links, or up to 32 posts from an expanded thread.

By default the CLI reads only the listed posts. `-t` adds the surrounding thread or author chain, as far as the site's returned replies reach; the iOS editor turns thread import on for new single-post captures and keeps the choice. See [CLI thread options](docs/cli-thread-options.md).

`--media auto` selects media from the listed posts, leaving media inside quoted posts unselected. `--media all` selects every attachment from listed posts, thread posts and `--extra` sources, and `images`, `video` and `audio` filter that set; a reference such as `--media 1.2` selects a single item, including one from a quoted post. See [CLI media choices](docs/cli-media-options.md).

Several images become a JPEG mosaic, and several videos an MP4 mosaic, with `--frame` and `--audio` picking poster frames and the soundtrack.

The CLI saves a SoundCloud track as an audio attachment, using the artist's original file when offered. For other tracks, yt-dlp and FFmpeg convert the public stream to MP3, and `--media none` saves the track URL alone. A playlist block lists its tracks in order, with the playlist artwork.

The iOS app gets SoundCloud audio as MP3 from an arena-block media service, configured in Settings with its HTTPS address and access token; it checks the file before uploading it to Are.na, and the Share extension uses the same settings. Without the service, text-only capture saves the track URL. Substack article audio uploads as the original file, in a block of its own.

`--quote-author-link source` links each quoted author to the quoted post, and `plain` shows the name alone. See [quote options](docs/cli-quote-options.md) and [quoted author links](docs/quoted-author-links.md).

Each plan keeps the source URLs, authors, dates and original records, with fetch notes kept apart from the block text. Bluesky and Delvetown links and mentions come from the post's facets, checked against its text; for an x.com article, the article goes in the block text and the post text in the description. When a source lacks data the block needs, the CLI stops with an error.

## Saving and recovery

Before creating a block, the client checks channel access and records the save's UUID and plan; afterward, it reads back the block and its channel placements. When a create response gets lost, the client marks the attempt as uncertain and holds off on creating another block.

Commands for existing saves:

- `save-status` reads a save by UUID
- `status` and `inspect` read a receipt
- `attempt` reads an uncertain attempt
- `retry-save` and `resume` continue a save from its stored plan
- `cancel-save` stops further work, leaving finished blocks and placements in Are.na

A [default channel](config.default-channel.example.json) receives saves that name no channel, or joins every save. See [routing and saved input](docs/default-channel-provenance.md).

The daemon keeps its state in `$XDG_DATA_HOME/arena-block` or `~/.local/share/arena-block`, and reads credentials from a private configuration file or environment variables.

```sh
ARENA_BLOCK_HOST=127.0.0.1 ARENA_BLOCK_PORT=8790 bun run src/cli.ts serve
```

The local channel picker, MCP server and browser helper all go through the daemon, checking its capabilities before accepting a plan.

## Development

```sh
bun run typecheck
bun run extension:typecheck
bun test
```

[Development](docs/development.md) covers dependencies, Nix packaging and native checks; [UI development](docs/design.md) covers editors and fixtures, and [Capture storage](docs/capture-storage.md) covers how the iOS app stores data.
