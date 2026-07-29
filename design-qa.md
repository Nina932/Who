# Morpheus cockpit design QA

Reference: `.design-qa/reference.png`

Implementation: `.design-qa/implementation-final.jpg`

Side-by-side comparison: `.design-qa/comparison-final.png`

Viewport and state: desktop cockpit, standing-by state. The reference was
normalized to the captured implementation viewport for the comparison.

## Visual checks

- Core hierarchy: passed. The center is the dominant element, with an
  asymmetrically deformed membrane, internal vapour, suspended particles,
  fine cyan/violet filament paths, and wider orbital threads.
- Floor and light current: passed. The core is connected to layered responsive
  wave bands through a tapered vertical filament column.
- Workforce presence: passed. Seats are quiet unlabeled light-seeds rather
  than diagram nodes. Their links are effectively absent at rest and appear
  only when work is routed; the attending specialist is named in the HUD.
- Voice and mood legibility: passed. Microphone bands drive motion at frame
  rate while the operational state owns the palette and slower posture. Quiet
  speech is expanded into a useful visual range and stressed syllables bypass
  the slower energy envelope.
- Ambient motion: passed. Two browser captures 900 ms apart changed 244,488
  channels in the central crop (mean channel difference 6.175), confirming the
  membrane flows continuously rather than relying on a whole-body pulse.
- Operational states: passed. Idle, listening, hearing, thinking, executing,
  speaking, completed, failed, and outcome-uncertain each map to a distinct
  state and visual profile.
- Header, navigation, and command dock: passed at desktop viewport with no P0,
  P1, or P2 clipping or overlap. Floating prompt/task chips were removed.
- Browser console: passed. No application errors were recorded. The only
  warning is Three.js's upstream `Clock` deprecation notice.
- Microphone gate: passed. When browser permission is absent, the interface
  explicitly says `ALLOW MICROPHONE` and does not pretend to be hearing input.
  Physical microphone response becomes testable only after that browser grant.

## Defects found and fixed

1. P0: post-processing could return a valid black WebGL frame without throwing.
   The additive shader scene is now the reliable default path.
2. P1: the center read as a fuzzy sphere. Added stable macro-lobes and reduced
   the internal wireframe weight.
3. P1: the floor read as one flat grid. Split it into three independently
   phased layers and added a tapered light current.
4. P1: nodes and labels still read as a network diagram. Replaced them with
   unlabeled light-seeds and hid connections until a seat is actually active.
5. P1: the product had no visible execution or outcome receipts. Added focused,
   completed, failed, and uncertain visual states.
6. P1: opener prompts looked like tasks floating in space. Removed them from
   the scene; voice and the anchored command dock are now the only inputs.
7. P0: localhost and 127.0.0.1 were treated as different origins, causing every
   spoken turn to fail with 403 in the preview. Loopback aliases now match only
   when their ports also match.
8. P1: ordinary speech was smoothed twice and then multiplied by very small
   deformation coefficients. Reduced analyser smoothing, accelerated the
   per-band envelopes, and applied a square-root response curve so conversational
   volume produces visible motion.
9. P1: emphasis was folded into the slow mood-energy signal, so consonants and
   stressed words disappeared. Added a direct `uEmphasis` shader channel that
   creates a short asymmetric membrane tear and brightness accent.
10. P1: idle motion still read as a pulse. Reworked it as faster advection and
    domain-warp flow, keeping scale changes local to measured voice energy.
11. P1: the membrane still read as concentric rings. Removed the nested shells
    and rebuilt the center from one irregular displaced boundary, two uneven
    vapour volumes, suspended particles, a restrained wire field, and thirteen
    independently oriented filament paths.
12. P1: the center was too small and geometrically regular beside the reference.
    Increased its presence, strengthened the six-lobed domain warp, and mixed
    selective violet threads into the cyan standing palette.
13. P0: speech recognition continued running while synthesized speech played,
    so Morpheus transcribed its own reply and routed words such as “close” to
    Sales. Recognition now aborts before synthesis, ignores late result events,
    and restarts only after the complete speech queue drains.
14. P1: local fallback replies recited specialist charters and incorrectly
    demanded an Anthropic key. Greetings now receive a direct greeting, and
    degraded replies name the supported Groq or Google paths without pretending
    a model answered.
15. P2: the central membrane still looked optically thick at rest. Tightened
    both Fresnel bands, reduced body and vapour opacity, pulled the rim closer
    to the main surface, and reduced the two internal volume shells. The live
    check also exposed a missing `uHot` declaration that prevented the rim
    shader from compiling; it is now declared and covered by a regression test.
16. P1: polar displacement converged into pointed crown and tail shapes, while
    the three-shell light column read as an unrelated cone attached to the
    core. Deformation now eases near both poles and the solid cone was removed;
    only the fine rising current remains.
17. P1: the orbiting lights had no discoverable meaning, and strong cursor
    camera parallax moved them away during inspection. Added an anchored
    `SPECIALISTS — HOVER OR TAP A LIGHT` key, constant-size hover identity
    labels, larger interaction targets, and restrained pointer drift.

## Central membrane thickness iteration

- Source visual truth: `.design-qa/reference.png`
- Implementation screenshot: `.design-qa/central-thin-final.png`
- Combined comparison: `.design-qa/central-thin-final-comparison.png`
- Viewport and density: 1456 × 1118 CSS pixels, 1456 × 1118 screenshot pixels,
  density normalized 1:1.
- State: desktop cockpit, standing by, settled WebGL scene.
- Full-view evidence: the central form keeps its scale and connection to the
  floor current, but the face is now substantially more transparent than the
  reference and no longer reads as a solid luminous mass.
- Focused-region evidence: the center was large enough in the normalized
  comparison to judge the membrane edge, internal wire field, vapour depth,
  and current connection without an additional crop.
- Fonts and typography: unchanged by this scoped iteration.
- Spacing and layout rhythm: unchanged; the core footprint and dock position
  remain stable.
- Colors and visual tokens: cyan/violet mood palette preserved while opacity
  was reduced.
- Image and asset fidelity: no raster or icon assets were added or replaced;
  the center remains the existing live shader system.
- Copy and content: unchanged.
- Interaction and console: voice-driven uniforms and mood transitions remain
  wired. The repaired render produced no new shader error; only the existing
  Three.js `Clock` deprecation warning appeared after reload.
- Comparison history: the first capture showed a thinner core but revealed the
  pre-existing rim compilation failure. The missing uniform was added, the
  scene was reloaded, and the final capture confirmed the repaired rim remained
  narrow rather than restoring the earlier visual weight.
- Remaining P3: the reference is intentionally brighter and denser than the
  user's requested direction; the implementation now favors ether and
  transparency over reference-level glow.

## Interaction verification

- Typed `hello` through the live command dock. The response was exactly one
  Chief of staff turn: “Hello, Nino. I’m here…” with no Sales handoff and no
  charter echo.
- Direct SSE verification returned Chief of staff attendance, conversational
  routing, the concise local greeting, and a truthful degraded status.
- After local Groq configuration, the same SSE route resolved `quick`, `hard`,
  `judgment`, and `extract` to Groq. A fresh live browser turn answered “hello”
  once, reached `COMPLETED`, created exactly one operator turn, and did not
  summon Sales or use the local fallback.
- Physical microphone echo suppression is covered by the recognition-floor
  assertions; a real spoken pass still requires browser microphone permission.

## Polar form and specialist discoverability iteration

- Source visual truth:
  `C:/Users/Nino/AppData/Local/Temp/codex-clipboard-164b586f-be6c-48ca-a5e8-b2bd8ca290e6.png`
  and
  `C:/Users/Nino/AppData/Local/Temp/codex-clipboard-c44bf5b7-ddcb-415a-b4b8-72447cf0a023.png`.
- Implementation screenshots: `.design-qa/core-cleanup-final.png` and
  `.design-qa/core-cleanup-hover.png`.
- Combined comparison: `.design-qa/core-cleanup-comparison.png`.
- Viewport and density: 1004 × 802 CSS pixels, 1004 × 802 screenshot pixels,
  density normalized 1:1. The two source images are focused user crops rather
  than full-viewport states, so the comparison preserves their crop and judges
  only the flagged regions.
- State: desktop cockpit, standing by, settled WebGL scene; hover and selected
  specialist states were also checked.
- Full-view evidence: the solid light cone is absent, the floor remains
  connected through a fine rising particle current, and the core no longer
  terminates in sharp polar assemblies.
- Focused-region evidence: the annotated crown, base, and cone regions are
  shown beside the revised full view. The hover capture visibly identifies
  `Email — Integration`, and tapping the same light opens its detailed
  inspector.
- Fonts and typography: existing HUD typography is preserved. New guidance and
  hover text use the same display/body font tokens, optical weight, uppercase
  treatment, and compact tracking as the cockpit.
- Spacing and layout rhythm: the guidance is anchored beneath the navigation
  rather than floating beside a node; the hover label is temporary and
  constant-size, so it does not recreate the earlier permanent tag clutter.
- Colors and visual tokens: cyan specialist guidance and violet integration
  identity use the existing semantic palette.
- Image and asset fidelity: no assets were replaced or approximated. The
  changes are to the existing live scene geometry and interaction surfaces.
- Copy and content: the lights now name their category and interaction directly;
  users are no longer expected to infer what they are.
- Primary interactions tested: hover revealed `Email — Integration`; tap opened
  the Email inspector; close returned to the clean scene.
- Console: no application or shader errors after the final reload. The existing
  upstream Three.js `Clock` deprecation warning remains.
- Comparison history: the first revision removed the polar/cone defects and
  added hover labels. Interaction QA then found that cursor parallax moved
  targets during hover. Pointer influence was reduced from strong camera
  steering to subtle ambient drift, after which the identity label resolved
  reliably.
- Remaining P3: orbit lights remain intentionally minimal at rest; the anchored
  guidance and hover/tap detail carry their meaning without filling the scene
  with permanent names.

## Reactive ether and task-current iteration

- Source visual truth: `.design-qa/reference.png`, interpreted with the
  operator's later overrides: no flying cubes or permanent node tags, a thinner
  ether body, a quieter non-generic background, and task-only electrical links.
- Implementation screenshots: `.design-qa/morpheus-reactive-idle.png`,
  `.design-qa/morpheus-reactive-thinking.png`, and
  `.design-qa/morpheus-reactive-executing.png`.
- Combined comparison: `.design-qa/morpheus-reactive-comparison.png`.
- Viewport and density: implementation 1090 x 802 CSS pixels and 1090 x 802
  screenshot pixels at 1:1 density. The 1448 x 1086 source was aspect-preserved
  and contained inside 1090 x 802 for the side-by-side comparison.
- State: standing by, thinking/executing on a three-domain request, and speaking
  were inspected. The active request routed Engineering as primary with
  Strategist and Researcher supporting, which exercised the maximum three
  current packets rather than lighting every connection.
- Full-view comparison evidence: hierarchy, top navigation, left HUD, centered
  ether body, orbital field, and anchored command dock remain aligned with the
  reference. The source's permanently bright node diagram and broad blue fog
  were intentionally not copied because the operator explicitly rejected those
  surfaces.
- Focused-region evidence: the central body was captured 900 ms apart in the
  same idle state. 525,801 of 2,622,540 image channels changed by more than
  three levels, with mean channel difference 3.461, confirming continuous
  ambient advection, asymmetric breathing, filament rotation, and camera drift.
  The executing capture shows three discrete bright packets on the primary
  current while other connections remain dark.
- Fonts and typography: existing HUD/display font tokens, hierarchy, tracking,
  and line lengths are unchanged. No new floating copy was introduced.
- Spacing and layout rhythm: core, header, command dock, transcript, and
  specialist callout remain within the 1090 x 802 viewport with no clipping or
  collision. The field no longer fills the bottom corners with heavy diagonal
  bands.
- Colors and visual tokens: calm remains cyan, thinking moves visibly to
  violet, executing becomes ice-blue, and speaking becomes amber. The sky now
  borrows the live mood palette through narrow aurora veils instead of fixed
  broad CSS color pools.
- Image quality and asset fidelity: the core and background remain live WebGL
  materials, not a static image. No supplied logo, icon, or raster asset was
  replaced. Star density and haze are rendered at device density without
  scaling artifacts.
- Copy and content: a generic greeting is now attributed to `Morpheus`, not
  `Chief of staff`. The browser-verified answer was: `Hey, I'm doing well,
  thanks. What's on your mind?`
- Interaction and accessibility: the typed command path, Enter submission,
  thinking/executing/speaking states, disabled Send state, and specialist
  attendance were tested. Existing reduced-motion damping remains active.
- Console: no application or shader errors. The only warning is Three.js's
  upstream `Clock` deprecation.

### Comparison history

1. P1: a social use of `today` routed to Chief of staff and generated invented
   week/calendar behavior. Casual greeting detection now bypasses staff
   attendance, and the system prompt keeps specialist routing internal.
2. P1: late synthesized speech still leaked back after the fixed echo timeout.
   Echo matching is now lexical and conservative instead of time-bounded, and
   the exact leaked phrase is covered by a regression test.
3. P1: the core looked static because its idle motion was mostly rotation and
   state color carried too little optical weight. Added three-phase asymmetric
   breathing, faster domain-warp advection, brighter but still thin colored
   filaments, and mood-colored sky veils.
4. P1: links were static tubes with one generic packet. Links now stay dark
   outside thinking/executing/speaking, flicker electrically only for attending
   specialists, and show one to three packets according to task load.
5. P2: the background used broad drifting dashboard gradients and the floor
   produced heavy diagonal bands. Replaced the broad pools with a deep vertical
   atmosphere, stable star field, narrow aurora, a tighter current column, and
   a more distant quieter floor.

No actionable P0, P1, or P2 visual findings remain for this iteration.

final result: passed
