# Video and Frame choices

Duration chooses a default, not permission to capture video. New captures use Video through 1500 seconds (25 minutes), inclusive. Above 1500 seconds, an observed poster may be the default Frame; Video remains selectable. A source without a poster remains Video. Explicit Video and Frame choices override the duration default. Frame has no motion or sound.

In iOS, use the Video / Frame picker on each video. Settings offers 1, 2, 5, 10 and 25 minutes and defaults to 25 minutes. An explicitly stored preference remains a preference, not a lock; older frozen captures retain their choices. Drafts, frozen submissions, source-option remapping and reopened previews retain explicit choices.

```
arena-block plan 'https://www.tiktok.com/@thechristopheralexander/video/7703354368283708703' --json
arena-block plan URL --video 1.1 --json
arena-block plan URL --frame 1.1 --json
arena-block plan URL --video-frame-threshold 1500 --video 1.1 --json
```

`--video` keeps moving video for the named refs regardless of the default. `--frame` explicitly chooses observed poster frames. Do not put the same ref in both. Inclusion stays separate through the existing media options. The serialized policy uses `videoMotion` beside existing `videoFrames`; the threshold is `videoFrameThresholdSeconds` (default 1500; configurable 1–86400). The threshold's numeric range is not a duration limit on a selected video.

`video-representation-v2` guards current helper/receiver planning and explicit choices. Older helpers must be updated; a stripped explicit choice, contradictory frame plan or unsupported receiver cannot silently downgrade selected Video to Frame. Existing immutable plans remain parseable. Native and CLI rendering no longer reject a source solely for exceeding ten minutes. Download, inspection or export failures stay failures; they do not automatically become frames.

Independent resource limits remain: native source files at most500 MiB; CLI video inputs at most750 MiB per source and aggregate, with at most1 GiB total staging; configured video output at most250 MiB; maximum 60 fps and bounded geometry. These are project processing limits, not a claim that Are.na has a universal duration limit. CLI encoding reserves space for its192 kbps audio setting and bounds video bitrate against output size; an encoding that cannot fit reports that budget error. Native export also checks complete video duration and expected audio after encoding. Long exports can take more time and require more compression to fit the output cap. They can fail on actual size, source-access, encoding, storage or platform constraints; a selected video never silently turns into a frame.

The former600-second default and ten-minute composition rejection first appear in repository root import `b1ca4d1` (October 13, 2026). Git establishes implementation provenance, not historical user approval. That safety/default policy was superseded by Josh's explicit November 2 instruction to use approximately 25 minutes and always permit representation selection.

The reported existing block 52262791 is a Frame Link from the 707-second TikTok above. This update leaves it untouched. The exact new native path acquired that source as Video and exported707.133 seconds of 720×1280 MP4 with audio,248086142 bytes, with distinct decoded beginning/end frames. This was a local acquisition/export check, not an Are.na test save or receiving playback claim. Tests cover25-minute boundaries, explicit overrides, frozen/restored choices, ref remapping, old-helper rejection, source-vs-output budgets and actual iOS preview controls.
