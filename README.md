<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/mark-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/mark.svg" />
  <img src="assets/mark.svg" width="32" height="32" alt="Arena Block" />
</picture>

# arena-block

Arena Block captures social posts as editable Are.na blocks.

It comes as a [CLI](docs/development.md), an [iOS app](ios/README.md) and a [browser extension](extension/README.md).

## CLI

Install Bun, then run:

```sh
bun install --frozen-lockfile
bun run src/cli.ts --help
bun run src/cli.ts plan 'https://x.com/example/status/123' --media none --json
bun run src/cli.ts publish --plan ./plan.json --to your-channel --dry-run
```

`plan` reads the sources and prints the block it would save: the title, text, selected media and a plan hash. Read it over, then pass it to `publish`. With `--dry-run`, `publish` prints the save and its destinations locally. To save for real, run the daemon with access to your Are.na account.

Run a command with `--help` to list its arguments and options. Help text wraps to the terminal width, or to 80 columns when piped. Set `COLUMNS` to pick a width, or `NO_COLOR=1` for plain text.

To write previews and conversation drafts to disk:

```sh
arena-block render --plan ./plan.json --layout reading --output-dir ./previews
arena-block thread 'https://bsky.app/profile/example.com/post/first' --scope chain --output-dir ./drafts
```

The reading layout keeps each source at its own scale when it fits the canvas. The wallpaper layout arranges the selection into an ordered overview. A conversation draft holds the source responses, Markdown, HTML and a coverage report. See [previews and drafts](docs/mosaic-thread-drafts.md).

## Visibility ratio

```sh
arena-block ratio
arena-block ratio --overlap both --json
```

`ratio` reads your channels through the daemon, then the block IDs in each channel. It prints how many channels and blocks are private, closed and public, with the ratio of private to public. It only reads, using GET requests.

`--overlap` sets how to count a block that appears in several channels:

- `public` (default): once, at its most open visibility
- `private`: once, at its most restricted visibility
- `both`: once under each visibility it appears in
- `placements`: adds up each channel's content count, without reading contents

`--cached` reads channels from the daemon's saved channel index.

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

A Substack Note gets the title **Note by @handle**. Each quoted Note keeps its own author. Article previews and selected excerpts carry labels to set them apart from the Note's text. Article audio and supported video go through the usual media options. See [Substack captures](docs/substack-notes.md), [support and limits](docs/substack-parity.md) and [source checks](docs/substack-contract-checks.md).

Reddit refuses some unauthenticated reads. When it answers with HTTP 401, 403, 429 or 503, the CLI stops and reports the status. Reddit records saved by earlier versions still open. See [Reddit source access](docs/reddit-source-access.md).

An Instagram Reel gets the title **Reel by @handle**, and other Instagram posts get **Post by @handle**. TikTok and Instagram carousels keep their source order. Media URLs from these sites expire after a while, so refresh an old plan before saving it.

For a Forum Magnum Quick Take or Shortform entry, use the comment permalink. The Shortform page itself holds no text to capture. GreaterWrong links resolve through LessWrong. Hacker News and Lobsters links need to point at a comment.

## Text and media

List posts in the order you want them read. The block's text and author labels come from those posts. To add media from another post without its text, pass that post with `--extra`. A plan holds up to 20 listed links, or up to 32 posts from an expanded thread.

By default the CLI reads only the posts you list. Add `-t` to include the surrounding thread or author chain on sites with thread support. How much it finds depends on the replies the site returns. The iOS editor turns thread import on for new single-post captures and remembers your choice. See [CLI thread options](docs/cli-thread-options.md).

`--media auto` picks media from the posts you list and leaves media inside quoted posts unselected. `--media all` selects every attachment from listed posts, thread posts and `--extra` sources. `images`, `video` and `audio` filter that same set. To include media from a quoted post, give its reference, such as `--media 1.2`. A saved plan keeps the media it had when you saved it. See [CLI media choices](docs/cli-media-options.md).

Several images become a JPEG mosaic. Several videos become an MP4 mosaic, with `--frame` and `--audio` choosing poster frames and the soundtrack.

With `--media auto`, `all` or `audio`, the CLI saves a SoundCloud track as an audio attachment. When the artist offers a download, the CLI uploads that original file unchanged. For other tracks, yt-dlp and FFmpeg convert the public stream to MP3. Use `--media none` to save the track URL. A playlist block lists its tracks in order, with the playlist artwork.

The iOS app saves SoundCloud audio through an arena-block media service. Enter the service's HTTPS address and access token in Settings. When you save a track, the app reads its details from SoundCloud, asks the service for an MP3, checks the file, then uploads it to Are.na. The app asks for an MP3 even when the artist offers a download. The Share extension uses the same settings. To save a track without the service, choose text-only capture.

Substack article audio uploads as the original file, in a block of its own.

Use `--quote-author-link source` to link each quoted author to the quoted post, or `plain` for the name alone. Without the option, each site keeps its usual style. See [quote options](docs/cli-quote-options.md) for the CLI and [quoted author links](docs/quoted-author-links.md) for the app and extension.

Each plan keeps the source URLs, authors, dates and original records. Notes about how the CLI fetched a source stay with those records, apart from the block text. Bluesky and Delvetown links and mentions come from the post's facets, checked against its text. For an x.com article, the article goes in the block text and the post text in the description. If a source lacks data the block needs, the CLI stops with an error.

## Saving and recovery

Before creating a block, the client checks that your account can add to each channel, then records the save's UUID and plan. After Are.na creates the block, the client reads it back along with its channel placements. If the create response gets lost, the client marks the attempt as uncertain so you can look before trying again.

Look up a save by UUID with `save-status`, a receipt with `status` or `inspect`, and an uncertain attempt with `attempt`. Check what they report before running `retry-save` or `resume`. `cancel-save` stops further work on a save, and the blocks and placements it already made stay in Are.na. A save keeps the content, media and channels you approved when you submitted it.

Configure a [default channel](config.default-channel.example.json) to use when you name no channel, or to add alongside every channel you name. See [routing and saved input](docs/default-channel-provenance.md). The daemon keeps its state in `$XDG_DATA_HOME/arena-block` or `~/.local/share/arena-block`, and reads credentials from a private configuration file or environment variables.

```sh
ARENA_BLOCK_HOST=127.0.0.1 ARENA_BLOCK_PORT=8790 bun run src/cli.ts serve
```

The local channel picker, MCP server and browser helper all go through the daemon. Before they accept a plan, they check that the daemon supports its sources and options.

## Development

```sh
bun run typecheck
bun run extension:typecheck
bun test
```

See [development](docs/development.md) for dependencies, Nix packaging and native checks, or [UI development](docs/design.md) for editors and fixtures. [Capture storage](docs/capture-storage.md) covers how the iOS app stores data and its storage report.
