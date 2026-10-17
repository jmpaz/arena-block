# Quoted author links

Link a quoted author's label to the quoted post, or display the name alone. In Capture, open **Quoted author**. In the browser extension, open **Edit sources**, **Capture options**, then **Composition** and **Quoted authors**.

| Choice | Generated credit |
|---|---|
| Keep current style | Use the platform's existing presentation: linked Substack credits, plain x.com, Bluesky and Delvetown credits |
| Link to quoted post | Link the author label to the quoted post's source URL |
| Name only | Display the author label without a link |

For a quoted x.com post:

```markdown
> [`@quoted`](<https://x.com/quoted/status/2>) (2026-10-15T12:00:00Z)
> Complete quoted prose.
```

With Name only:

```markdown
> `@quoted` (2026-10-15T12:00:00Z)
> Complete quoted prose.
```

The composer applies the choice to included quotes, using their retained authors and source URLs. Native and browser previews display those links. Changing the choice recomposes retained sources while keeping manually edited writing. Draft restoration retains the setting, and submission freezes it with the plan.

In the CLI, use [`--quote-author-link source|plain`](cli-quote-options.md). The optional `policy.quoteAuthorLink` field records an explicit choice. Helpers and receivers check for `quote-author-links-v1` before accepting it. Plans without that field retain their existing presentation and hashes.

Frozen two-level fixtures cover Substack, x.com, Bluesky and Delvetown. Tests compare generated credits, source identities, media, saved hashes and receiver rejection of missing or altered policy fields. Native runtime and UI receiving use separate checks.
