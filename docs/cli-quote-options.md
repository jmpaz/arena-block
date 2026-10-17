# Quoted author links in the CLI

Choose whether a quoted author's credit links to the quoted **post**:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-author-link source
arena-block plan 'https://x.com/writer/status/123' --quote-author-link plain
```

`source` links the author name to that quoted post's source URL. `plain` leaves
the same name unlinked. Both choices apply to every rendered quote in Substack,
x.com, Bluesky and Delvetown captures. Author identity, quote order, dates,
original media and independently retained source provenance stay intact.

For a quote by `@writer`, the two Markdown credits are:

```md
> [`@writer`](<https://substack.com/@writer/note/c-123>)
> `@writer`
```

When you omit the option, the composer uses the existing presentation for each
platform. It leaves the optional policy field absent, so older plans retain
their hashes. When you choose a mode, the CLI records it in the new plan and
checks receiver support for `quote-author-links-v1` before submitting a save.

The option does not rewrite an existing `--plan` capture or a saved item.
Create and review a new composition to change its presentation. This option is
independent of `--quote`, `--quote-depth`, `--quote-dates` and thread expansion.
