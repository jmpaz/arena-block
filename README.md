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

`plan` reads each source, composes the block and prints its title, text, selected media and plan hash. `publish` sends a plan to the daemon, which creates the block on Are.na. With `--dry-run`, `publish` prints the save and its destinations and stops there.

Help text wraps to the terminal width, or to 80 columns when piped. `COLUMNS` sets another width, and `NO_COLOR=1` turns off color.

```sh
arena-block render --plan ./plan.json --layout reading --output-dir ./previews
arena-block thread 'https://bsky.app/profile/example.com/post/first' --scope chain --output-dir ./drafts
```

`render` writes local image previews. The reading layout keeps each source at its own scale when it fits the canvas. The wallpaper layout arranges the selection into an ordered overview. `thread` writes a conversation draft with the source responses, Markdown, HTML and a coverage report. See [previews and drafts](docs/mosaic-thread-drafts.md).

## Sources

| Provider | Supported input |
|---|---|
| x.com | Post permalinks, public articles and author threads, read through FxTwitter |
| Bluesky, [Delvetown](https://delve.town) | Post links or `at://` post URIs, read through public AppViews |
| Mastodon | Public HTTPS post permalinks, read through the instance's status API; a boost resolves to the original post |
| Reddit | Public posts and comments, read as JSON |
| LessWrong, Alignment Forum, EA Forum | Post and comment permalinks, read through each site's GraphQL API |
| Substack | Public Notes, free public articles, original media and article cards |
| TikTok, Instagram | Post, video and share permalinks, read through FxEmbed Atmosphere |
| SoundCloud | Public tracks and playlists, with track audio saved as an attachment |
| Hacker News, Lobsters | Comment permalinks, read through public APIs |

A Substack Note gets the title **Note by @handle**. Each quoted Note keeps its own author. Article previews and selected excerpts carry labels separating them from the Note's text. Article audio and supported video go through the shared media options. See [Substack captures](docs/substack-notes.md), [support and limits](docs/substack-parity.md) and [source checks](docs/substack-contract-checks.md).

Reddit refuses some unauthenticated reads. On HTTP 401, 403, 429 or 503, the CLI stops and reports the status. Reddit records saved by earlier versions still open. See [Reddit source access](docs/reddit-source-access.md).

An Instagram Reel gets the title **Reel by @handle**, and other Instagram posts get **Post by @handle**. TikTok and Instagram carousels keep their source order. Media URLs from these sites expire after a while, and planning again fetches fresh ones.

Forum Magnum Quick Takes and Shortform entries resolve from their comment permalinks, since a Shortform container page holds no text of its own. GreaterWrong links resolve through LessWrong. Hacker News and Lobsters links resolve to a single comment.

## Text and media

The CLI composes posts in the order given, taking the block's text and author labels from them. `--extra` adds media from another post without its text. A plan holds up to 20 listed links, or up to 32 posts from an expanded thread.

By default the CLI reads only the listed posts. `-t` adds the surrounding thread or author chain on sites with thread support, as far as the site's returned replies reach. The iOS editor turns thread import on for new single-post captures and keeps the choice. See [CLI thread options](docs/cli-thread-options.md).

`--media auto` selects media from the listed posts and leaves media inside quoted posts unselected. `--media all` selects every attachment from listed posts, thread posts and `--extra` sources. `images`, `video` and `audio` filter that same set. A reference such as `--media 1.2` selects media from a quoted post. A saved plan keeps its media selection. See [CLI media choices](docs/cli-media-options.md).

Several images become a JPEG mosaic. Several videos become an MP4 mosaic, with `--frame` and `--audio` picking poster frames and the soundtrack.

With `--media auto`, `all` or `audio`, the CLI saves a SoundCloud track as an audio attachment. When the artist offers a download, the CLI uploads that original file unchanged. For other tracks, yt-dlp and FFmpeg convert the public stream to MP3. `--media none` saves the track URL alone. A playlist block lists its tracks in order, with the playlist artwork.

The iOS app gets SoundCloud audio from an arena-block media service, configured in Settings with the service's HTTPS address and access token. On save, the app reads the track's details from SoundCloud, requests an MP3 from the service, checks the file and uploads it to Are.na. The app requests an MP3 even when the artist offers a download. The Share extension uses the same settings. Text-only capture saves a track without the service.

Substack article audio uploads as the original file, in a block of its own.

`--quote-author-link source` links each quoted author to the quoted post, and `plain` shows the name alone. Without the option, each site keeps its usual style. See [quote options](docs/cli-quote-options.md) for the CLI and [quoted author links](docs/quoted-author-links.md) for the app and extension.

Each plan keeps the source URLs, authors, dates and original records. Notes about how the CLI fetched a source stay with those records, apart from the block text. Bluesky and Delvetown links and mentions come from the post's facets, checked against its text. For an x.com article, the article goes in the block text and the post text in the description. When a source lacks data the block needs, the CLI stops with an error.

## Saving and recovery

Before creating a block, the client checks that the account can add to each channel, then records the save's UUID and plan. After Are.na creates the block, the client reads it back along with its channel placements. When a create response gets lost, the client marks the attempt as uncertain and holds off on creating another block.

`save-status` reads a save by UUID, `status` and `inspect` read a receipt, and `attempt` reads an uncertain attempt. `retry-save` and `resume` continue a save from its stored plan. `cancel-save` stops further work on a save, leaving its blocks and placements in Are.na. A save keeps the content, media and channels approved at submission.

A [default channel](config.default-channel.example.json) receives saves that name no channel, or joins every save alongside the named channels. See [routing and saved input](docs/default-channel-provenance.md). The daemon keeps its state in `$XDG_DATA_HOME/arena-block` or `~/.local/share/arena-block`, and reads credentials from a private configuration file or environment variables.

```sh
ARENA_BLOCK_HOST=127.0.0.1 ARENA_BLOCK_PORT=8790 bun run src/cli.ts serve
```

The local channel picker, MCP server and browser helper all go through the daemon. Each checks the daemon's capabilities before accepting a plan.

## Development

```sh
bun run typecheck
bun run extension:typecheck
bun test
```

[Development](docs/development.md) covers dependencies, Nix packaging and native checks. [UI development](docs/design.md) covers editors and fixtures. [Capture storage](docs/capture-storage.md) covers how the iOS app stores data.
