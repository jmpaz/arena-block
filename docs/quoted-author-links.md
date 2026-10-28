# Quoted author links

A quoted author's name can link to the quoted post or appear alone. The iOS app keeps this setting under **Quoted author**. The browser extension keeps it under **Edit sources**, **Capture options**, **Composition**, **Quoted authors**.

| Choice | Result |
|---|---|
| Keep current style | Each site's usual style: linked names for Substack, plain names for x.com, Bluesky and Delvetown |
| Link to quoted post | The author's name links to the quoted post |
| Name only | The author's name appears without a link |

A quoted x.com post with **Link to quoted post**:

```markdown
> [`@quoted`](<https://x.com/quoted/status/2>) (2026-10-15T12:00:00Z)
> Complete quoted prose.
```

With **Name only**:

```markdown
> `@quoted` (2026-10-15T12:00:00Z)
> Complete quoted prose.
```

The composer applies the choice to every included quote, using the author and URL saved with it. The app and extension previews show the resulting links. Changing the choice rebuilds the text from the saved sources and keeps manual edits. A restored draft keeps the setting, and a submitted save keeps the setting it had at submission.

The CLI takes [`--quote-author-link source|plain`](cli-quote-options.md). The plan records an explicit choice in `policy.quoteAuthorLink`. Helpers and receivers check for `quote-author-links-v1` before accepting it. Plans without the field keep their existing style and hash.
