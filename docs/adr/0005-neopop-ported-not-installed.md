# NeoPOP is ported, not installed

The look is CRED's NeoPOP, but `@cred/neopop-web` is not a dependency. Its peer is React 17/18 (the app is on 19), it needs styled-components v5, ships no types, and has one 2022 release. Its sixteen components also have no counterpart for the stage, backdrop, roster or talk tiles. So the values (colours, the 3px 45-degree plunk, the 120ms press, extra-bold type, square corners) are read from its source and written as Tailwind tokens and two utilities (`.plunk`, `.flat`) in `theme.css` and `globals.css`.

Consequence: a face of `#0d0d0d` on a `#121212` page is about 1.05:1, so the plunk edges (and a real border under `prefers-contrast: more`) carry the boundary; `theme.test.ts` checks text and fill pairs and cannot catch this. The primary is purple rather than NeoPOP's black so the main action is a visible fill.

The display font (Bricolage Grotesque) comes from `next/font`, which ships with Next, and is not an npm package of its own.
