# CLI thread expansion

By default, the CLI captures only the listed posts. `-t` or `--thread-expansion` adds the thread or author chain around them, on sites with thread support:

```sh
arena-block plan 'https://x.com/writer/status/123' -t --json
arena-block 'https://bsky.app/profile/writer.example/post/abc' --thread-expansion
```

The flag takes no value. The usual limits on thread size still apply, and a site can return only part of a public thread. Two other commands work apart from this flag: `thread` writes a local conversation draft, and `resolve` reads the listed posts as they are.

Author-chain expansion follows verified consecutive posts by the same author. A selected descendant can identify its ancestor branch; a forward fork or incomplete evidence cannot establish a unique continuation. Forum Magnum chains stop at another author. Hacker News and Lobste.rs parent depth includes ancestor context separately; it does not expand replies or count those ancestors as selected posts.

Fresh verified author chains with at least three included posts use a **Thread by** title. Quotes, media-only extras and independently listed posts do not establish that title. Authored source titles remain literal. Retained plans keep their approved titles and hashes; layout-only recovery preserves the approved writing in a new plan.

The older forms `--thread-expansion on` and `off`, including `=on` and `=off`, still work with a deprecation warning on stderr: `on` matches the bare flag, and `off` matches leaving it out. The CLI rejects `auto` before reading any source.

When a command repeats the option, the last value wins, and a value given to a subcommand overrides one given before it.

These defaults cover new plans created by the CLI. `render --plan` and `publish --plan` use the plan as saved, with its policy and hash; an explicit `--mosaic-layout` derives a new layout without changing the original file. The iOS app, the browser extension, save recovery and the shared protocol keep their own thread defaults.
