# Quoted author links in the CLI

Choose the quoted author's link style when creating a plan:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-author-link source
arena-block plan 'https://x.com/writer/status/123' --quote-author-link plain
```

`source` links the author label to the quoted post. `plain` leaves it unlinked. Omit the option to keep the platform's existing presentation. Quote inclusion, depth and dates use their separate options.

An explicit choice requires `quote-author-links-v1` on the receiver. With `--plan`, the CLI uses the saved policy and hash. Create and review a new composition to change an earlier plan's presentation.

See [quoted author links](quoted-author-links.md) for app and browser controls and Markdown examples.
