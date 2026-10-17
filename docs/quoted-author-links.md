# Quoted author links

A quote credit can link its author label to the **quoted post**. This is a presentation choice. The quoted author identity, canonical post URL, authored text, quote order, dates, media ownership and retained source records remain unchanged.

`policy.quoteAuthorLink` accepts `source` or `plain`. It is optional. An absent value preserves the existing presentation and immutable plan hash: Substack credits keep their current links; x.com, Bluesky and Delve credits keep their current plain labels. Existing saved items and queued plans are not rewritten.

In Capture, use the per-capture **Quoted author** menu to choose **Keep current style**, **Link to quoted post** or **Name only**. The choice survives draft restoration and submission; it changes generated credits while preserving edited writing. Changing source presentation reuses the retained source tree. It does not request more quotes or change the native thread default.

The explicit modes apply consistently across Substack, x.com, Bluesky and Delve, including nested quotes. They also apply to the shared composer's other supported quote providers. The link always targets the quoted post's canonical URL, never an inferred author profile. Omitting a quote still omits its credit; its retained source is not discarded.

For a quoted x.com post, the generated Markdown changes as follows:

```markdown
# Link to quoted post
> [`@quoted`](<https://x.com/quoted/status/2>) (2026-10-15T12:00:00Z)
> Complete quoted prose.

# Name only
> `@quoted` (2026-10-15T12:00:00Z)
> Complete quoted prose.
```

The equivalent Substack example uses the quoted Note URL, such as `https://substack.com/@quoted/note/c-2`; Bluesky and Delve use their canonical post URLs. Both modes display the same author and writing. Native read-only previews render the author label and preserve the link target when enabled; the editable Markdown remains intact.

An explicit mode requires `quote-author-links-v1` before a receiver is asked to resolve or save it. The client, native helper and browser transport check the returned policy and immutable plan hash. A helper that strips or substitutes the option fails clearly. Plans without the option require no new capability for this feature.

Verification uses four frozen, deterministic two-level quote plans, one per provider. Tests compare complete legacy plans and hashes, both generated presentations, source and media identity, quote/date order, native Markdown link targets, reopened drafts and frozen submissions. Mock receiver/helper checks cover missing support and stripped responses; no real save is part of these tests.
