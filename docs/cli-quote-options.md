# Quoted author links in the CLI

`--quote-author-link` sets how quoted authors appear in a new plan:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-author-link source
arena-block plan 'https://x.com/writer/status/123' --quote-author-link plain
```

`source` links the author's name to the quoted post, and `plain` shows the name alone; without the option, each site keeps its usual style. Quote inclusion, depth and dates have their own options.

Either value requires a daemon with `quote-author-links-v1`. With `--plan`, the CLI uses the style and hash saved in the plan. A different style for an earlier plan takes a new plan.

[Quoted author links](quoted-author-links.md) covers the app and extension controls, with Markdown examples.
