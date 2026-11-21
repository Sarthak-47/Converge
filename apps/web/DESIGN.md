---
name: Converge
description: A real-time IDE where every person and every agent is a die-cut sticker on the same laptop lid.
colors:
  aluminium-lid: "#d8dade"
  sheet-white: "#fbfbfa"
  sheet-tint: "#f0f1f2"
  rail-aluminium: "#e4e6e9"
  graphite-ink: "#16171a"
  pewter-muted: "#50545b"
  pewter-faint: "#666a72"
  seam: "#d1d4d8"
  seam-strong: "#a9adb4"
  hover-wash: "#ecedef"
  pressed-wash: "#e2e4e8"
  down-red: "#b3261e"
  die-white: "#ffffff"
  hinge-graphite: "#1b1c20"
  hinge-chalk: "#f2f2ee"
  hinge-muted: "#a7aab1"
  hinge-line: "#34363c"
  lemon-signal: "#ffd400"
  lemon-deep: "#ffc700"
  lemon-ink: "#16171a"
  sticker-tomato: "hsl(9 100% 59%)"
  sticker-cobalt: "hsl(230 100% 58%)"
  sticker-mint: "hsl(153 79% 43%)"
  sticker-bubblegum: "hsl(333 100% 69%)"
  sticker-violet: "hsl(258 72% 52%)"
  sticker-sky: "hsl(195 100% 42%)"
  terminal-night: "#16171a"
  terminal-chalk: "#e9e9e4"
  graphite-lid: "#24262b"
  graphite-sheet: "#17181b"
  graphite-sheet-raised: "#26282d"
  graphite-rail: "#1e2024"
  chalk-ink: "#f2f2ee"
  night-muted: "#a8abb2"
  night-faint: "#8e929a"
  night-seam: "#33353b"
  night-seam-strong: "#4c4f57"
  night-hover: "#2a2c31"
  night-pressed: "#30333a"
  night-down: "#ff8f85"
typography:
  display:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Archivo Variable, Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 800
    lineHeight: 1.3
    fontVariation: "'wdth' 108"
  body:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.5
  sticker:
    fontFamily: "Archivo Variable, Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 900
    lineHeight: 1.15
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 125"
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  sticker: "8px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "48px"
components:
  button:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
    height: "32px"
  button-primary:
    backgroundColor: "{colors.lemon-signal}"
    textColor: "{colors.lemon-ink}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.lemon-deep}"
    textColor: "{colors.lemon-ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.pewter-muted}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.graphite-ink}"
  input:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "38px"
  state-pill:
    backgroundColor: "transparent"
    textColor: "{colors.pewter-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  state-pill-done:
    backgroundColor: "{colors.graphite-ink}"
    textColor: "{colors.sheet-white}"
  live-pill:
    backgroundColor: "{colors.lemon-signal}"
    textColor: "{colors.lemon-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 10px"
  card:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.lg}"
  top-bar:
    backgroundColor: "{colors.hinge-graphite}"
    textColor: "{colors.hinge-chalk}"
    height: "56px"
    padding: "0 16px"
  brand-sticker:
    backgroundColor: "{colors.lemon-signal}"
    textColor: "{colors.lemon-ink}"
    typography: "{typography.sticker}"
    rounded: "{rounded.sticker}"
    padding: "0.18em 0.6em"
  avatar-sticker:
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.pill}"
    size: "30px"
  side-tab-active:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.graphite-ink}"
    rounded: "{rounded.sticker}"
    height: "30px"
---

# Design System: Converge

## Overview

**Creative North Star: "The Sticker Lid"**

A Converge workspace is a laptop lid. The shell is the lid itself: brushed aluminium in light, graphite in dark, with a graphite hinge (top bar and status bar) that never changes between themes. The open file sits on it as the flattest, quietest sheet. Everything that is a *who* (a person, an agent, a lane owner, a remote cursor, the brand) is a die-cut vinyl sticker slapped onto that lid: a flat saturated colour, a white die-cut border, a soft lift shadow, and a small tilt that is fixed per identity so the same person always sits on the lid the same way.

Colour is owned, not decorative. Six sticker colours belong to people; lemon belongs only to primary actions and Live; everything else is graphite, aluminium and white. State is never carried by borrowing someone's colour: it is carried by shape (filled, hollow, dashed, dotted, struck through). Density is IDE-dense in the working rails and generous only on sign-in, where the lid itself is the brand moment. The system rejects the grey IDE with one blue accent and the gradient-banner SaaS look; it replaced a cyanotype world the owner judged generic.

**Key Characteristics:**
- A lid, a hinge and sheets: three planes, and stickers on top of them.
- Six person colours, one lemon signal, everything else achromatic.
- State by shape: filled is done, hollow is idle, dot is live, dashed is pending or down, dotted is cancelled or denied.
- One type scale (12 / 14 / 17 / 22 / 30); rank by weight and case, not by new sizes.
- Archivo, wide and heavy, only on stickers, the brand and the workspace name.

## Colors

An achromatic metal-and-paper shell with saturated sticker vinyl and a single lemon signal on top.

### Primary
- **Lemon Signal** (`lemon-signal`): the one action colour. Primary buttons, the Live connection pill, the CONVERGE brand sticker, text selection, link underlines and the comment-range wash. Always paired with **Lemon Ink** (graphite) text, never white.
- **Lemon Deep** (`lemon-deep`): primary-button hover and the resting link underline.

### Secondary (the six person stickers)
Assigned per user id by `colorFor`; text on each is chosen by `inkFor` (graphite or white, whichever contrasts more). They are identity, nothing else.
- **Tomato** (`sticker-tomato`), **Cobalt** (`sticker-cobalt`), **Mint** (`sticker-mint`), **Bubblegum** (`sticker-bubblegum`), **Violet** (`sticker-violet`), **Sky** (`sticker-sky`): avatars, lane stickers, remote-cursor flags, chat who-dots, the owner's dashed die line on an agent sticker. Kept as `hsl()` strings because collaboration awareness only accepts that form from other clients.

### Neutral
- **Aluminium Lid / Graphite Lid** (`aluminium-lid` / `graphite-lid`): the page background in light / dark; the surface stickers are slapped onto.
- **Sheet White / Graphite Sheet** (`sheet-white` / `graphite-sheet`): the editor, cards, inputs and the active tab. The quietest plane.
- **Sheet Tint** (`sheet-tint` / `graphite-sheet-raised`): banners, comment quotes, file-comment strips.
- **Rail Aluminium / Graphite Rail** (`rail-aluminium` / `graphite-rail`): file rail, side panel, history list. Recedes behind the sheet.
- **Graphite Ink / Chalk Ink** (`graphite-ink` / `chalk-ink`): body text, focus rings, filled state pills.
- **Pewter Muted / Faint** (`pewter-muted`, `pewter-faint`; dark `night-muted`, `night-faint`): secondary text, idle pills, placeholders and row chevrons.
- **Seam / Seam Strong** (`seam`, `seam-strong`; dark `night-seam`, `night-seam-strong`): 1px dividers and the 1.5px control borders.
- **Hover / Pressed Wash** (`hover-wash`, `pressed-wash`; dark `night-hover`, `night-pressed`): row hover, selected tree row, the segmented-tab track.
- **Down Red** (`down-red` / `night-down`): failure text only, always with a dashed or struck shape beside it.
- **Die White** (`die-white`; `chalk-ink` in dark and on the hinge): the die-cut border around every sticker.
- **Hinge Graphite / Chalk / Muted / Line** (`hinge-*`): top bar and status bar, identical in both themes.
- **Terminal Night / Chalk** (`terminal-night`, `terminal-chalk`): approval commands and job output, in both themes.

### Named Rules
**The Owned Colour Rule.** A sticker colour means a person and nothing else. Never use one for a status, a category, a button or a highlight.

**The Lemon Is Rare Rule.** Lemon marks the primary action and Live. If two lemon things compete on one screen that are not the brand sticker and Live, one of them is wrong.

**The Shape Carries State Rule.** Status is told by fill, outline style and strike: filled = done or decided, hollow = idle or waiting, leading dot = running or live (pulsing), dashed = pending, gotcha, warning or down, dotted = cancelled, denied or expired, struck = cancelled or failed tool. Red text may accompany a dashed shape; it never carries state alone.

## Typography

**Display Font:** Figtree Variable (UI sans fallback stack)
**Sticker Font:** Archivo Variable, width axis 108 to 125%, weights 800 to 900
**Mono Font:** JetBrains Mono Variable

**Character:** Figtree is a friendly, neutral working face for every control and paragraph; Archivo stretched wide and heavy is the printed vinyl on the stickers, so a word set in it reads as an identity, not a heading.

### Hierarchy
- **Display** (800, 30px, 1.1, -0.02em): page h1 (Workspaces, status), sign-in headline, the lid logo sticker.
- **Headline** (800, 22px): dialog titles, the sign-in card title, lid stickers on sign-in.
- **Title** (Archivo 800, 17px, width 108%): workspace names in the list and top bar, session task, empty-state titles (those in Figtree 800).
- **Body** (400, 14px, 1.45): all UI text, chat and turns. Sign-in sub copy steps up to 17px, capped at 32rem.
- **Label** (700, 12px): state pills, connection pill, metadata. Rail and panel section headings (Files, Plan, Notes, Comments) are 12px 800 uppercase at 0.08em tracking; they title real sections and are the only uppercase in the working UI.
- **Mono** (12px to 14px): code, file names on stickers, the status bar, timestamps, commands, service names.

### Named Rules
**The Five Sizes Rule.** 12, 14, 17, 22, 30. A new level of emphasis comes from weight (600 / 700 / 750 / 800) or case, never from a new size.

**The Archivo Is Vinyl Rule.** Archivo appears only on stickers, the brand and the workspace name. Body copy and controls never use it.

## Layout

The IDE is a three-column grid on the lid: a 248px file rail, a flexible editor stage, and a 360px side panel, between a 56px hinge top bar and a 30px hinge status bar. The open file owns the stage; rails sit on the darker rail colour and recede. At 1000px and below the side panel drops to its own full-width row (min 260px, 38vh) so chat never disappears; at 640px everything stacks into one column and the top bar wraps, hiding the theme switch, role badge and name.

Content pages (workspaces) are a single 760px column with 48px top padding (32px on phones). The status page is 520px. Sign-in is a 1.6fr / 1fr split: the lid with stickers on the left, the form card centred on the right; it collapses to one column at 860px.

Spacing is a tight 4px-based rhythm: 4 / 6 / 8 / 12 / 16 in rails and rows, 24 to 48 only on page margins and the sign-in story.

## Elevation & Depth

Depth has one job: stickers lift off the lid. Only stickers cast a shadow, a short tight lift plus their die-cut ring. Sheets, rows, banners and pills are flat and separated by hairlines; an active row or version is a ruled chip (an inset 1.5px ink line), and the active tab is an ink fill.

### Shadow Vocabulary
- **Lift** (`0 6px 14px -5px rgb(22 23 26 / 0.45), 0 1px 2px rgb(22 23 26 / 0.18)`; dark `0 7px 16px -5px rgb(0 0 0 / 0.75), 0 1px 2px rgb(0 0 0 / 0.5)`): under every sticker, and nowhere else.
- **Sheet** (`none`): cards, lanes, the create form and the services list are flat, with a hairline border. Hovering shadows on panels read as generated UI and were removed on purpose.
- **Die cut** (`0 0 0 2.5px` die colour, 4px on sign-in stickers): the white border every sticker wears, composed before Lift.
- **Focus ring** (`0 0 0 2px` surface, `0 0 0 4px` ink): every focusable element; inputs instead get an ink border with a 3px lemon halo.

### Named Rules
**The Only Stickers Lift Rule.** An element casts a shadow only if it is a sticker (an identity or the brand). Tilt follows the same rule: working rows, chat avatars and workspace tiles stay straight. A pill always means a state; plain labels such as roles are text.

## Shapes

Gently rounded and never sharp: 6px on controls, 8px on stickers and segmented tabs, 10px on lane sheets and session cards, 14px on cards, full pills for state and avatars. Stickers are tilted with `--tilt`, a deterministic angle between -3deg and +3deg derived from the identity's id (sign-in stickers are hand-placed up to 8deg; the brand sticker sits at -2.5deg). Outline style is part of the vocabulary: 1.5px solid for controls, 2px dashed for pending and warnings, dotted for cancelled and denied, and a dashed or dotted inner outline in the owner's colour marks an agent.

## Components

### Buttons
Tactile and plain: a white sheet button with a strong seam, pressing down 1px.
- **Shape:** gently rounded (6px), 1.5px border in `seam-strong`, 32px minimum height, 600 weight.
- **Primary:** lemon fill, graphite border and text, 750 weight; hover deepens to Lemon Deep.
- **Hover / Focus / Active:** border darkens to ink on hover; 2px+2px ink focus ring; `translateY(1px)` on press; disabled at 50% opacity.
- **Ghost:** transparent and muted, hover wash. On the hinge it uses `hinge-muted` with an 8% white hover.
- **Icon:** borderless 28px square, muted until hover. **Link:** ink text with a 2px lemon underline.

### Chips (state pills)
- **Style:** full pill, 1.5px `currentColor` outline, transparent, 12px 700 label, muted by default.
- **State:** follows the Shape Carries State Rule. Running gets a leading dot that pulses; done and decision memories are filled ink; failed is dashed in Down Red; cancelled is dotted and struck.

### Cards / Containers
- **Corner Style:** 14px (cards), 10px (lane sheets, session cards, approvals).
- **Background:** Sheet White / Graphite Sheet.
- **Shadow Strategy:** Sheet shadow; session and approval cards use a border instead.
- **Border:** 1px seam on cards; approval cards 2px dashed ink while pending, solid when approved, 1.5px dotted seam when denied or expired; a session awaiting takeover is 2px dashed ink.
- **Internal Padding:** 12 to 16px; auth card 32px 28px.

### Inputs / Fields
- **Style:** 38px tall, 1.5px `seam-strong` border, 6px radius, sheet background, faint placeholder.
- **Focus:** border goes to ink plus a 3px lemon halo at 70%.
- **Create form:** the input sits borderless inside a 6px-padded sheet; the whole sheet takes a 2px ink ring when focused.

### Navigation
- **Top bar (the hinge):** 56px, hinge graphite in both themes, brand sticker, workspace name in Archivo 17px 800, role pill, Live pill, presence stickers, theme switch.
- **Side tabs:** a segmented track in Pressed Wash with 3px padding; the active tab is a white sheet with Lift and 750 weight.
- **File rail:** 30px rows, 7px radius, muted until hover; the open file is a lifted white sheet in bold; unsaved is a hollow 9px ring.
- **Status bar:** 30px hinge strip in mono 12px; unsaved shows a hollow ring.

### Stickers (signature)
- **Person avatar:** 30px circle (24px in rows) in the person's colour, initials in Archivo 850 at 110% width, ink from `inkFor`, white die cut, Lift, per-id tilt. Slaps on at join (380ms: from -10deg and 1.35x scale).
- **Agent avatar:** the same circle in white with a 2px dotted inner outline in the owner's colour: hollow, because an agent acts for someone.
- **Lane sticker:** the lane's heading pinned over the top edge of its sheet in the owner's colour, Archivo at 112% width, tilted.
- **Cursor flag:** a 6px-rounded tag above the remote caret in the person's colour, tilted -3deg.
- **Brand sticker:** CONVERGE in Archivo 900 at 125% width on lemon, tilted -2.5deg.

### Budget Tape (signature)
A 12px pill track of 9px ticks (Pressed Wash on Sheet Tint) inside a 1.5px seam; the fill is solid ink. Fixed capacity: it fills and cannot overflow.

### Terminal blocks
Approval commands and job output are Terminal Night with Terminal Chalk mono at 12px, 6px radius, in both themes. In dark mode Terminal Night is a step deeper (#0b0c0e) than the sheet, and the command strip carries a hairline, so it never merges with the card.

### Comic grammar (signature)
Each kind of voice has one comic device, and only conversation and agent lanes use them; the editor stays plain.
- **Speech balloon** (a person speaking): chat messages and a person's prompt or steering to their agent. 1.5px ink outline, 10px radius, a rotated-square tail pointing up at the speaker's sticker; your own (and prompts) tinted 14 to 16% with the speaker's colour.
- **Caption box** (the agent narrating): the agent's text output. Square corners, 1.5px ink rule, Sheet Tint fill. No shadow.
- **Thought bubble** (an agent thinking): agent notes, which come from the model's thinking. A pill outline with two small circles trailing back toward the agent.
- **Rubber stamp** (a decision): APPROVED, DENIED (red) or EXPIRED (dotted) rotated on a decided approval card. Decoration only; its text is hidden from assistive technology because the sentence beside it names who decided.
- **Halftone** (the printer's dot): a faint dot screen on the sign-in lid and the empty editor only, never behind working content.

- **Typing dots** (still talking): a running agent turn ends in a small caption box whose three dots light in turn, above its cost and actions.
- **Empty balloon** (nothing said yet): an empty chat is a dashed balloon inviting the first line.

Tool lines are not comic: they stay plain mono, the record of what happened.

## Do's and Don'ts

### Do:
- **Do** give every person and agent a sticker: colour from `colorFor`, ink from `inkFor`, tilt from `tiltFor`, white die cut and Lift.
- **Do** mark agents as hollow stickers with the owner's colour as a dashed or dotted inner line.
- **Do** carry state by shape (filled, hollow, dot, dashed, dotted, struck) so it reads in greyscale.
- **Do** keep the hinge (`hinge-graphite`) identical in light and dark.
- **Do** stay on the 12 / 14 / 17 / 22 / 30 scale and rank by weight.
- **Do** wrap every motion in `prefers-reduced-motion: no-preference`; slaps use `cubic-bezier(0.22, 1, 0.36, 1)`, everything else `cubic-bezier(0.16, 1, 0.3, 1)` at 140 to 220ms.

### Don't:
- **Don't** use a sticker colour for a status, a category or a button.
- **Don't** use lemon for anything but primary actions, Live, the brand, selection and link underlines.
- **Don't** set body copy or controls in Archivo.
- **Don't** add shadows to anything that is neither a sticker nor a sheet.
- **Don't** rebuild the grey IDE with a single blue accent, or a gradient-banner SaaS header.
- **Don't** tilt sheets, controls or text; only stickers tilt.
