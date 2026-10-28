# Quoted author links

You can link a quoted author's name to the quoted post, or show the name alone. In the iOS app, open **Quoted author**. In the browser extension, open **Edit sources**, **Capture options**, then **Composition** and **Quoted authors**.

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

The composer applies the choice to every included quote, using the author and URL saved with it. The app and extension previews show the resulting links. Changing the choice rebuilds the text from the saved sources and keeps your manual edits. A restored draft keeps the setting, and a submitted save keeps the setting it had when you submitted it.

In the CLI, use [`--quote-author-link source|plain`](cli-quote-options.md). The plan records an explicit choice in `policy.quoteAuthorLink`. Helpers and receivers check for `quote-author-links-v1` before accepting it. Plans without the field keep their existing style and hash.
