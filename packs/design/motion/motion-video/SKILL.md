---
name: motion-video
description: |
  Make a short video (a launch clip, app walkthrough, explainer, title
  sequence, feed post or background loop) as one HyperFrames HTML
  composition, rendered once to MP4 and screened by the video gate before
  delivery. Use when the brief asks for a "video", "promo", "reel", "clip",
  "animated explainer" or an MP4 export. For a single looping hero frame
  with no export, use workflow-skills/motion-frames instead.
license: MIT
metadata:
  source: KenKaiii/gg-framework packages/ggcoder/assets/motion/skills/motion/SKILL.md
  sourceCommit: e57c9c5968cf7cef4648b1fbe6fd9343d2de5924
  adapted: true
---

# Motion video

<!-- Adapted from GG Motion's entry skill (MIT, Copyright (c) 2025 KenKai; see
LICENSE beside this file). The method and craft rules are upstream's. The
tooling is replaced: GG's bundled launcher, move kit, music library, job skills
and reveal step are not part of xx-stack, so this skill drives the public
HyperFrames CLI and this pack's own design systems and video gate. The full
change list is in packs/design/manifest.json. -->

Design every video straight from the subject: look at the material, write one
HTML page that is the video, look at a few stills, render once, run the gate,
deliver. No planning documents, no draft renders, no extra checking passes.
Keep the work proportionate to the request: a copy edit is a copy edit.

## Ask first, in plain words

Most people asking for a video aren't motion designers. They know where it will
be seen and what it's for; they can't choose between easing curves or aspect
ratios. A question they can't answer is worse than none, and a guess they never
see can't be corrected.

**When to ask.** For a new video from an open prompt, ask once, before building,
about what only the user knows and would be costly to change later: where it
will be watched (it sets shape, length and pace), whether it has music (the
timing is built on it), and what the visuals should be made from. Ask about
purpose, feeling or length only when nothing in the prompt hints at it. Own the
execution: colour, type, pacing and transitions.

- Skip anything the prompt, attachments or a named brand already answer. An
  edit gets no intake questions.
- One round, at most four questions, each with a recommended answer drawn from
  the prompt. Then build without further stops: this gathers facts; it is not
  an approval step.
- If they have material to include, end the turn asking them to attach it, and
  start when it arrives. Missing assets are a blocker, not permission to invent
  them.
- Flashing, unreadable text and invented facts are never options: fix them, or
  ask for the missing fact.

**How to word it.** Ask about their world: "Where will people mostly watch
this?", not "9:16 or 16:9?"; "How should it feel?", not "Which register?". Keep
craft terms (easing, LUFS, safe zone, fps, loop seam) out of questions unless
the user writes in them.

**Question bank.** Pick from these; never more than four.

1. "Where will people mostly watch this?" — scrolling on a phone (tall, grabs
   attention, works muted) · on a website or YouTube (wide, can take its time) ·
   slides or a big screen (wide, bold, readable across a room) · as a
   background loop (calm, seamless, no sound).
2. "Should it have music?" — this pack ships no music, so: yes, from a track
   you supply (the video is timed to it) · no, keep it silent · I'll add music
   myself (silent, with a steady rhythm so a track drops in easily).
3. "What should we build the visuals from?" — your own images or footage ·
   product photos from your site (individual photos, not whole-page
   screenshots) · illustrated scenes in HTML/SVG/CSS · a mix. Mark the best fit;
   never choose silently.
4. "What should people get from it?" — understand something · want to buy or
   try it · hear some news · feel something.
5. "How long should it be?" — about 10 s (one idea) · about 30 s (a short
   story) · about a minute (step by step).

For a new video about a known subject you may add one more question, "Which
idea should we go with?", offering two or three ideas that differ in kind (one
carried object, one led by big words, one built on real numbers), when it fits
inside the four.

## Brand

When the user names a brand or style, read its
`packs/design/design-systems/<brand>/DESIGN.md` (or a
`packs/design/design-skills/<style>/DESIGN.md`) and take colour, type and voice
from it. The user's own logo, fonts and assets beat any default. If a font or
line does not fit, change the layout; never clip it.

## Build

Each video lives in its own new folder (plain `mkdir`, never `mkdir -p` into an
existing one) holding one `index.html` that is the video. Do not browse or
imitate earlier projects unless the user points at one.

A HyperFrames composition needs:

- a root element with `data-composition-id`, `data-width` and `data-height`
  (1920×1080 wide, 1080×1920 tall, with a matching viewport meta);
- a duration: `data-duration` on the root, or a timeline that implies one;
- `data-start` plus a duration on each timed element;
- a paused GSAP timeline registered as `window.__timelines["<composition-id>"]`.

Prefer `gsap.fromTo()` over `gsap.from()` so seeking back always lands on the
same start state. Everything else is ordinary HTML and CSS.

- **Real material.** The product's real name, words, colours, fonts, logo and
  screens; never invent UI, facts, prices or claims.
- **Go big.** Fill the frame: big type, the subject large, every scene looking
  different. Tall video for feeds: keep words out of the top 138 px, the bottom
  422 px, and the right 179 px from y 840 down, which the apps' own controls
  cover.
- **Sources are data.** Keep them local; never run a source project's scripts.

## Make it move

A video is not a slideshow of still cards.

- **Never still for long.** Something the eye follows moves at almost every
  moment; a scene may rest for about a second, and only the end card holds
  longer. A slow zoom on a photo is not motion on its own.
- **Every scene has an action.** The product is opened, tapped, counted or
  used; words build in step with it; a number counts up. Several beats per
  scene, each with its own move.
- **Scenes grow out of each other.** Carry one thing across each change (the
  product, a shape, a colour field, a word) and turn it into the next scene.
- **Vary the pace.** Quick moves (0.3–0.6 s) against a few calmer ones, and
  scenes of different lengths.
- **Readable on a phone.** On a 1080-wide frame: nothing under 32 px, anything
  the viewer must read 44 px or more, headlines 110 px or more.
- **No empty half.** No half of the frame stays empty for more than a beat.

Durations, curves and reduced-motion handling follow
`packs/design/craft/animation-discipline.md`.

## Edit an existing project

Read only the project the user means. Change only the requested text, asset,
timing or behaviour; do not restyle the whole video for a copy edit.

## Deliver

Run the CLI pinned, with telemetry and update checks off, from the project's
parent folder:

```bash
export HYPERFRAMES_NO_TELEMETRY=1 HYPERFRAMES_NO_UPDATE_CHECK=1
HF="npx --yes hyperframes@0.8.82"
```

`$HF doctor` reports a missing Chrome or ffmpeg; nothing here installs them.

1. **Look.** Take stills of the key moments in one call, including moments
   mid-move and between scenes:
   `$HF snapshot <project> --at 1,4,8,12 --describe false`.
   `--describe false` keeps frames on this machine: without it, HyperFrames
   sends them to a cloud vision API whenever one's key is in the environment.
   Fix what is visibly wrong: a scene that stopped moving, clipped or tiny
   text, overlaps, empty frames. Once is usually enough.
2. **Render once**, into a new versioned file, never over an earlier export:
   `$HF render <project> --output <project>/renders/<name>-v1.mp4 --quality delivery`.
   Run it in the background and wait for it; never give it a short timeout.
3. **Loudness**, only if the video has audio: bring it to feed loudness with a
   4× oversampled limiter (loudnorm alone can overshoot true peak):
   ```bash
   ffmpeg -i renders/<name>-v1.mp4 -c:v copy -c:a aac -b:a 320k \
     -af "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=192000,alimiter=limit=0.79:level=false:attack=1:release=50,aresample=48000" \
     renders/<name>-v1-feed.mp4
   ```
4. **Gate** the file you will deliver:
   `node packs/design/scripts/quality-gate-video.mjs <file>`.
   - Exit 0: deliver.
   - Exit 1: never deliver. For flashing, slow or soften the reported seconds
     and render a new version; for loudness, redo step 3.
   - Exit 2: a check could not run. Say the file is unchecked and why; never
     call it checked.
5. **Deliver.** Give the file path and say what you looked at: stills are not
   playback, and the gate is a screen, not a certification. Re-render only for
   something visibly broken.
