# Quoted author links in the CLI

Choose how quoted authors appear when you create a plan:

```sh
arena-block plan 'https://substack.com/@writer/note/c-123' --quote-author-link source
arena-block plan 'https://x.com/writer/status/123' --quote-author-link plain
```

`source` links the author's name to the quoted post. `plain` shows the name alone. Without the option, each site keeps its usual style. Quote inclusion, depth and dates have their own options.

Either value requires a daemon with `quote-author-links-v1`. With `--plan`, the CLI uses the style and hash saved in the plan. To change the style of an earlier plan, create a new plan and review it.

See [quoted author links](quoted-author-links.md) for the app and extension controls, with Markdown examples.
