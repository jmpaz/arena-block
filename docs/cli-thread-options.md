# CLI thread expansion

By default, the CLI captures only the posts you list. Add `-t` or `--thread-expansion` to include the thread or author chain around them, on sites with thread support:

```sh
arena-block plan 'https://x.com/writer/status/123' -t --json
arena-block 'https://bsky.app/profile/writer.example/post/abc' --thread-expansion
```

The flag takes no value. The usual limits on thread size still apply, and a site can return only part of a public thread. Two other commands work separately from this flag: `thread` writes a local conversation draft, and `resolve` reads the listed posts as they are.

Older scripts can keep passing `--thread-expansion on` or `off`, including the `=on` and `=off` forms. The CLI accepts them with a deprecation warning on stderr. Replace `on` with the bare flag, and drop the flag where a script passes `off`. The CLI rejects `auto` before reading any source. When a command repeats the option, the last value wins. A value given to a subcommand overrides one given before it.

These defaults cover new plans created by the CLI. `render --plan` and `publish --plan` use the plan as saved, with its policy and hash. The iOS app, the browser extension, save recovery and the shared protocol keep their own defaults.
