---
name: Converge
description: A real-time IDE where people and their agents braid into one live file.
colors:
  blueprint-paper: "#edf1f8"
  sheet-white: "#ffffff"
  sheet-tint: "#f3f6fb"
  rail-wash: "#e6ecf6"
  prussian-ink: "#0d1a36"
  slate-muted: "#4c5c7e"
  slate-faint: "#66748f"
  hairline: "#d3dcec"
  hairline-strong: "#b5c3dc"
  cyan-accent: "#0b6fa4"
  cyan-wash: "#dcf0fa"
  marigold-signal: "#ffb020"
  marigold-deep: "#f59e0b"
  marigold-ink: "#1a1200"
  hover-wash: "#edf2fb"
  active-wash: "#dfe8fd"
  up-wash: "#e1f5ec"
  up-ink: "#11734c"
  down-wash: "#fde8e6"
  down-ink: "#b42318"
  warn-wash: "#fff3d6"
  warn-ink: "#7a4b00"
  unsaved-rust: "#c2410c"
  terminal-night: "#0a1020"
  terminal-text: "#dfe7fb"
  cyanotype-deep: "#0a2f4e"
  cyanotype-ink: "#f3f6ff"
  prussian-night: "#06121d"
  night-sheet: "#0a1a29"
  night-sheet-raised: "#0e2233"
  night-rail: "#081724"
  night-ink: "#e6ecfa"
  night-muted: "#93acc4"
  night-faint: "#7f97b0"
  night-hairline: "#17324a"
  night-hairline-strong: "#24476a"
  night-cyan: "#6cc6ec"
  night-cyan-wash: "#0d2d40"
  night-marigold: "#ffb627"
  night-marigold-bright: "#ffc54f"
  thread-vermilion: "hsl(12 85% 58%)"
  thread-teal: "hsl(168 80% 38%)"
  thread-violet: "hsl(252 90% 66%)"
  thread-magenta: "hsl(330 75% 56%)"
  thread-azure: "hsl(212 100% 58%)"
  thread-lime: "hsl(84 70% 42%)"
typography:
  display:
    fontFamily: "'Bricolage Grotesque Variable', 'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 3.3rem)"
    fontWeight: 750
    lineHeight: 1.02
    letterSpacing: "-0.035em"
    fontVariation: "'opsz' 96"
  headline:
    fontFamily: "'Bricolage Grotesque Variable', 'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
    fontVariation: "'opsz' 48"
  title:
    fontFamily: "'Bricolage Grotesque Variable', 'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 700
    letterSpacing: "-0.015em"
  body:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'ss01', 'cv11'"
  label:
    fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    letterSpacing: "0.08em"
  mono:
    fontFamily: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "9px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  sheet-gap: "10px"
  md: "14px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.marigold-signal}"
    textColor: "{colors.marigold-ink}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.marigold-deep}"
  button-secondary:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.prussian-ink}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.hover-wash}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.sm}"
    padding: "5px 12px"
  input:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.prussian-ink}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "36px"
  pill-live:
    backgroundColor: "{colors.marigold-signal}"
    textColor: "{colors.marigold-ink}"
    rounded: "{rounded.pill}"
    padding: "1px 9px 1px 8px"
  pill-state:
    backgroundColor: "{colors.sheet-tint}"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.pill}"
    padding: "1px 9px"
  card:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.lg}"
  sheet:
    backgroundColor: "{colors.sheet-white}"
    rounded: "{rounded.lg}"
  topbar:
    backgroundColor: "{colors.cyanotype-deep}"
    textColor: "{colors.cyanotype-ink}"
    height: "52px"
    padding: "0 14px"
---

# Design System: Converge

## Overview

**Creative North Star: "The Cyanotype Instrument"**

Converge is a working instrument printed in Prussian blue. The ground is blueprint paper in light and Prussian night in dark, and both themes are first-class. Structure is drawn with cool hairlines and a few raised white (or night-blue) sheets; nothing on the chrome competes for colour. A deep cyanotype band, a diagonal gradient from Prussian to near-navy, is the one saturated surface: it runs across the top bar, opens the workspaces page and fills the left two-thirds of sign-in, where the thread field is drawn.

The colour lives in the threads. Every person and every agent carries one hue from a six-step thread palette, and that hue follows them everywhere they act: cursor, avatar, chat name, agent turn, session lane. Agents are the same hue as their sponsor, drawn dotted where people are drawn solid. Against that calm, one marigold signal marks the single thing to do next (the primary action) and the fact that the room is live (the connection pill, the brand mark's knot). Cyan-blue is reserved for focus, links, selection and the active file.

Density is IDE density: 14px body, 28px rows, 32px controls, 52px bar. Motion is short and eased (`cubic-bezier(0.16, 1, 0.3, 1)`), used for arrival (avatars join, dialogs rise, threads draw in) and live state (a slow pulse), and fully removed under reduced motion.

**Key Characteristics:**
- Prussian-blue grounds and blueprint hairlines in both themes; light and dark are equals.
- A cyanotype gradient band as the brand surface: top bar, page head, sign-in story.
- Per-author thread colour carried through every attributed surface; agents dotted, people solid.
- One marigold signal for the primary action and live state only.
- Floating sheets: editor and side panel raised on the ground; the file rail sits flat on it.
- Pills for state; full-tint borders; no side stripes.

## Colors

A cool, nearly monochrome blueprint palette where hue is spent on people and one warm signal.

### Primary
- **Marigold Signal** (marigold-signal; night-marigold in dark): the one warm voice. Fill of primary buttons, the connected pill, the selected theme in the top bar, and the knot where threads meet in the brand mark and the sign-in field. Text on it is always Marigold Ink, never white.
- **Marigold Deep** (marigold-deep): border and hover fill of the primary button.

### Secondary
- **Cyan Accent** (cyan-accent; night-cyan in dark): focus ring (3px at 30% alpha), focused input border, links, `button.link`, the active file's icon, workspace-memory decision chips, dotted memory underlines, and Monaco keywords. Never a button fill.
- **Cyan Wash** (cyan-wash; night-cyan-wash): background of the active file row and decision chips.
- **Cyanotype Band** (gradient `160deg, #0d3a5f → #0a2f4e → #082842`; dark `#0b2f4d → #08243c → #061c30`; cyanotype-deep is its midpoint): top bar, workspaces page head, sign-in story panel, workspace monograms. Text on it is Cyanotype Ink, secondary text Cyanotype Ink at 72%, hairlines white at 16%.

### Tertiary
- **The Thread Palette** (thread-vermilion, thread-teal, thread-violet, thread-magenta, thread-azure, thread-lime): six hsl hues that read on both grounds and stay clear of marigold and cyan. `colorFor(userId)` hashes a user to one hue; it is set as `--who` on chat messages, agent turns and lanes, and drives cursors and avatars. Lanes tint to 7% of the hue with a 40% border; your own chat bubble tints to 12%; names mix to 62% hue with ink. The brand mark draws threads 1-3; the sign-in field draws all five people/agents.

### Neutral
- **Blueprint Paper** (blueprint-paper) / **Prussian Night** (prussian-night): the page ground.
- **Sheet White** (sheet-white) / **Night Sheet** (night-sheet): raised sheets, cards, inputs, the editor.
- **Sheet Tint** (sheet-tint) / **Night Sheet Raised**: pills, segmented-control wells, lanes, composer trays.
- **Rail Wash** (rail-wash) / **Night Rail**: history rail and other recessed lists.
- **Prussian Ink** (prussian-ink) / **Night Ink**: body text.
- **Slate Muted** (slate-muted) / **Night Muted**: secondary text, ghost buttons, section labels.
- **Slate Faint** (slate-faint) / **Night Faint**: placeholders, idle icons, row arrows. Use on sheets, not on Blueprint Paper (4.2:1 there).
- **Hairline** / **Hairline Strong** (and night pair): all borders; strong for hover and dashed empty states.
- **Status pairs**: up (succeeded, approved, saved), down (failed, refused, errors), warn (running, gotcha, awaiting takeover). Always a wash background with its own ink, never ink on ground alone.
- **Unsaved Rust** (unsaved-rust; `#ff8a5c` in dark): the dirty dot, "unsaved" in the status line, comment ranges, awaiting-takeover card border.
- **Terminal Night** / **Terminal Text**: command chips and sandbox output, the same in both themes.

### Named Rules
**The Threads Carry the Colour Rule.** Hue on the chrome is the exception. A colour that is not a thread, the marigold signal, the cyan accent or a status wash does not appear. If you want colour on a surface, ask whose thread it is.

**The One Signal Rule.** Marigold means "do this" or "this is live". One primary action per region; never a decorative marigold.

**The Equal Themes Rule.** Every token has a light and a dark value; nothing is designed in one theme and inverted for the other.

## Typography

**Display Font:** Bricolage Grotesque Variable (with Geist, system sans)
**Body Font:** Geist Variable (with system-ui, Segoe UI)
**Label/Mono Font:** JetBrains Mono Variable (with ui-monospace, Consolas)

**Character:** A characterful, optically-sized grotesque for the brand and headings set tight and heavy, over a quiet, precise UI sans with stylistic set 01. Mono is a working face: code, IDs, file paths, commands, timestamps and the status line.

### Hierarchy
- **Display** (750, clamp(2rem, 3.4vw, 3.3rem), 1.02, opsz 96, -0.035em): the sign-in headline only.
- **Headline** (700, 2rem, 1.1, opsz 48, -0.025em, balanced): page h1; 2.4rem in the workspaces band, 2.2rem on status, 1.85rem on the sign-in sheet.
- **Title** (700, 1.05-1.35rem, -0.01 to -0.02em): workspace name in the bar, session task, dialog h2 (1.3rem), empty-state titles (1.2-1.35rem). The wordmark is the same face at 750, -0.03em.
- **Body** (400, 14px, 1.45): all UI. Emphasis at 550-650; the variable axis is used in between standard weights.
- **Label** (700, 0.72rem, 0.08em, uppercase): section labels inside panels only: the file tree header and session sections (Plan, Lanes, Comments).
- **Mono** (0.72-0.88rem): status line (0.74rem, +0.01em), chat timestamps, tool calls, file lists, command chips, service names.

### Named Rules
**The Display Face Is a Voice, Not a Size Rule.** Bricolage marks names and headings (brand, workspace, session, dialog, empty state); controls, pills and body never use it.

**The Mono Means Machine Rule.** Anything a machine produced or will consume (paths, commands, IDs, times, the status line) is set in JetBrains Mono.

## Layout

The IDE is a three-column grid (file rail 260px, editor flexible, side panel 340px) under a full-width 52px bar and over a status line. Sheets float with a 10px gutter on the ground; the bar sits 10px above them. At 1000px the side panel drops beneath the editor (rail 220px, panel min 260px / 38vh). At 640px everything stacks into one column, sheets lose their radius, borders and shadow, the wordmark, theme switch and role badge hide, and the bar's middle and the editor toolbar scroll sideways instead of widening the page.

Pages (workspaces, status) centre a single column: 760px for workspaces, 520px for status, 16px side gutters, 48px top. Sign-in is a 2fr / minmax(380px, 1fr) split that collapses to one column at 860px.

Spacing runs on a tight rhythm of 4, 6, 8, 10 and 14px inside panels, with 16-28px padding on sheets and cards. Rows are 28px in trees and tabs, controls 32px, inputs 36px, primary sign-in submit 40px; coarse pointers get 40px theme-switch targets.

## Elevation & Depth

A hybrid: tonal layering does most of the work (ground, rail, sheet, tint), and a three-step cool shadow scale says how far a sheet sits off the ground. Shadows are tinted with Prussian ink in light and pure black in dark. Inside sheets, selection is shown by tint or a 1px hairline ring, not by lift.

### Shadow Vocabulary
- **Rest** (`--shadow-sm`; light `0 1px 2px rgb(13 26 54 / 0.06), 0 1px 1px rgb(13 26 54 / 0.04)`): buttons, cards, avatars, the selected segment.
- **Sheet** (`--shadow-md`; light `0 6px 18px -6px rgb(13 26 54 / 0.16), 0 2px 4px rgb(13 26 54 / 0.05)`): editor and side panel sheets, the create form, the services list.
- **Lifted** (`--shadow-lg`; light `0 24px 60px -18px rgb(13 26 54 / 0.35), 0 6px 14px rgb(13 26 54 / 0.08)`): dialogs, the sign-in sheet, the workspaces band.
- **Band** (`0 1px 0 rgb(0 0 0 / 0.12), 0 8px 24px -16px rgb(8 23 64 / 0.7)`): the cyanotype top bar's edge.
- **Signal glow** (`0 1px 0 rgb(255 255 255 / 0.35) inset, 0 4px 12px -4px` marigold at 70%): primary buttons only.
- **Focus** (`--ring`, `0 0 0 3px` cyan at 30-32%): every focusable element, as a box-shadow, never an outline.

### Named Rules
**The Rail Sits, Sheets Float Rule.** The file rail and status line belong to the ground; the editor and side panel are the raised sheets. Do not raise navigation.

## Shapes

Gently rounded and consistent: 6px on controls, inputs and code chips; 9px on segmented wells, session cards, lanes and approval cards; 14px on sheets, cards and empty states. Rows and segments inside a well use 7px so they nest under 9px. Pills (999px) carry every state: role, connection, agent status, step status, memory kind, badges. Avatars and presence dots are circles; agent dots are dotted rings. Borders are always full 1px hairlines around a shape; empty states use a dashed strong hairline; held ranges use a 135deg hatch.

The brand mark is three round-capped threads converging into one line with a marigold knot; the 24-unit icon set is drawn at 1.6 stroke with round caps and joins to match.

## Components

### Buttons
Calm, tactile and small; the press is a 1px drop.
- **Shape:** gently rounded (6px), min height 32px, 5px 12px padding, 500 weight, 6px icon gap.
- **Primary:** Marigold Signal fill, Marigold Deep border, Marigold Ink text at 650, signal glow. Hover fills Marigold Deep.
- **Secondary (default):** Sheet White with a hairline border and rest shadow; hover goes to Hover Wash with a strong hairline.
- **Ghost:** transparent, Slate Muted text; hover gets Hover Wash and ink. In the top bar, ghost text is Cyanotype Ink at 72% and hover is white at 10%.
- **Icon:** 26px square, borderless, muted; 16px drawn icon.
- **Link:** cyan, underlined at 3px offset, no chrome.
- **Active / Disabled:** `translateY(1px)` on press; disabled at 55% opacity.

### Chips / Pills
- **Style:** 999px radius, 1px 9px padding, 0.72-0.78rem at 550-650, Sheet Tint with Slate Muted by default.
- **State:** status pills switch to their wash/ink pair (warn for running and in-progress, up for done/succeeded, down for failed/refused/budget). The connection pill turns marigold when connected and pulses its dot (2.4s); a running agent pulses at 1.6s.

### Cards / Containers
- **Corner Style:** 14px for cards and sheets, 9px for session and approval cards and lanes.
- **Background:** Sheet White; lanes and trays Sheet Tint; approval cards mix warn wash into the sheet (approved mixes up wash, denied/expired fall back to Sheet Tint).
- **Shadow Strategy:** rest for cards, sheet for the floating editor and panel, lifted for dialogs.
- **Border:** full 1px hairline; state changes recolour the whole border (cyan on hover for session cards, rust for awaiting takeover).
- **Internal Padding:** 10-12px for cards in panels, 22px for dialogs, 26-32px for the sign-in sheet.

### Inputs / Fields
- **Style:** 36px high, 0 11px padding, 6px radius, Sheet White, hairline border; placeholder Slate Faint.
- **Focus:** border turns cyan and the 3px cyan ring appears. A composed field (the create-workspace form) moves the ring to its container via `:focus-within`.
- **Hover:** strong hairline.

### Navigation
- **Top bar:** a 52px strip of the cyanotype band in both themes: brand mark and wordmark, a 1px white-16% divider, the workspace name in the display face, the live pill, presence avatars ringed in band blue, and the theme switch whose selected segment is marigold.
- **Side tabs:** a segmented well (Sheet Tint, 9px, hairline) of 28px segments; the active segment inverts to ink on surface.
- **File tree:** 28px rows with 7px radius inside a 6px inset; hover Hover Wash; the open file gets Cyan Wash with a cyan icon; folder chevrons rotate 90deg; row actions appear on hover or focus.

### Thread Presence (signature)
The thread is the system's signature. Each author's hue (`--who`) colours a 9px solid dot before a person's name and an 11px dotted ring before an agent's, the author name, the tint of your own chat bubble (10px 10px 10px 3px), and the border and wash of a session lane. Presence avatars are 28px circles filled with the hue, overlapping by 6px with a 2px surface ring, and arrive with a staggered 420ms rise. Remote cursors in Monaco carry the same hue with a name flag.

### Thread Field (signature)
On sign-in, a drawn SVG on the cyanotype band: coloured threads (people solid at 5px, agents dotted `2 9` at 3px) flow in over a 40px blueprint grid at 9% white, braid into one line and meet at a marigold knot labelled with a file name in mono. People's threads draw in staggered by 110ms; agent threads flow continuously; all of it is static under reduced motion.

## Do's and Don'ts

### Do:
- **Do** give every attributed thing (message, turn, lane, cursor, avatar) its author's thread hue via `colorFor`, and draw agents dotted in their sponsor's hue.
- **Do** keep marigold to the primary action, live state and the brand knot, with Marigold Ink text on it.
- **Do** use the cyan accent for focus, links, selection and the active file, and the 3px cyan ring for every focus state.
- **Do** carry state in pills and wash/ink pairs, and recolour the whole border when a card changes state.
- **Do** set paths, commands, IDs, times and the status line in JetBrains Mono.
- **Do** define both light and dark values for any new token, and honour `prefers-reduced-motion` by stopping every animation.
- **Do** float the working sheets (editor, side panel) and keep the rail and status line on the ground.

### Don't:
- **Don't** fill buttons with the cyan accent or scatter hue across controls; colour belongs to threads and the one signal.
- **Don't** use coloured side stripes to mark cards, lanes or alerts; tint and border the whole shape instead.
- **Don't** put white text on marigold, or Slate Faint text on Blueprint Paper.
- **Don't** add thread hues outside the six-step palette; remote awareness colours must pass the hsl validator.
- **Don't** use the display face for controls, pills or body copy.
- **Don't** raise the file rail or nest sheets inside sheets.
