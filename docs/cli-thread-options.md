# CLI thread expansion

New CLI compositions capture only the explicitly supplied posts by default. Add
`-t` or `--thread-expansion` to request a bounded supported thread or author chain:

```sh
arena-block plan 'https://x.com/writer/status/123' -t --json
arena-block 'https://bsky.app/profile/writer.example/post/abc' --thread-expansion
```

The flag takes no value. CLI composition has no `auto` mode. Provider validation
and existing thread bounds still apply; the flag does not promise that a complete
thread is publicly available. The separate `thread` command continues to create
its own explicit local conversation draft, and `resolve` continues to read the
requested provider records without composing a thread.

Existing scripts using `--thread-expansion on` or `--thread-expansion off`
(including `=on` and `=off`) continue to work with a deprecation warning on stderr.
Replace `on` with the presence-only flag and remove the flag entirely for `off`.
Legacy `auto` is rejected before acquisition. Repeated explicit choices use the
last value within the same command; a subcommand's explicit choice takes priority
over an inherited root flag.

These defaults apply only when the CLI creates a new composition. `render
--plan` and `publish --plan` keep the frozen plan, its policy and its hash. Native
Capture, browser intake, retained save recovery and shared protocol defaults are
unchanged.
