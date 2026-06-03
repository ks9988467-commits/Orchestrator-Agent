# Design

Visual system for Orchestrator Agent dashboard. Single-file app (`dashboard.html`), light theme, product register. All values live as CSS custom properties in `:root` — this doc mirrors them.

## Theme

Light. Neutral working surfaces with bold brand accents reserved for action/selection/status. Decided by scene: operators in an office, daytime, scanning data and tuning agents — a calm light surface that lets the red/yellow brand signal pop where it matters.

## Color (OKLCH-intent, stored as hex tokens)

### Brand
- `--red #da0d15` — Ketchup Red. Primary actions, current selection, active nav, key indicators. NOT decoration.
- `--red-dk #b80d12` — hover/pressed red.
- `--yellow #ffd405` — Cyber Yellow. Badges, agent tags, benchmark lines, empty-state energy. **Background only, always with black text.** Never a foreground text color.
- `--black #111111`

### Ink ramp (text) — all AA-verified on white
`--ink-1 #111` (18:1) · `--ink-2 #555` (7:1) · `--ink-3 #6b6c6f` labels (5.3:1) · `--ink-4 #6e6e6e` muted (5.2:1) · `--ink-5 #767676` placeholder (4.5:1) · `--ink-6 #949494` faint/decorative (3:1, large or non-text only). Ramp tuned for the a11y-priority requirement: every text-carrying step clears WCAG AA.

### Surface (second neutral layer for panels)
`--bg-0 #fff` card/panel · `--bg-1 #f5f5f5` app bg · `--bg-2 #f0f0f0` input/hover · `--bg-3 #fafafa` messages/subtle. Sidebar + toolbars sit on bg-0/bg-1 to separate from content.

### Border
`--border #e5e5e5` · `--border-dk #d0d0d0`

### Semantic
`--green #22c55e` success · `--amber #f59e0b` warning · `--rose #ef4444` error. Always paired with an icon or text, never color-only.

## Typography
- Family: **Inter** + **Noto Sans SC** (CJK), system-ui fallback. One family system; no display/body pairing (product register). Mono for data/code/IDs.
- Fixed px scale (not fluid): `--t-xs 10` · `--t-sm 11` · `--t-base 13` · `--t-md 14` · `--t-lg 15` · `--t-xl 18` · `--t-2xl 24`. Ratio ~1.2.
- Weights 400/500/600/700 carry hierarchy. Numbers/CPL/spend in monospace for alignment.

## Spacing & Radius
- 4-pt grid: `--sp-1 4` → `--sp-7 28`. Page horizontal padding `--px 28px` (16px on mobile).
- Radius: `--r-sm 6` · `--r-md 8` · `--r-lg 12`. One scale, no ad-hoc values.

## Components
- **Buttons**: `.btn-primary` (red), `.btn-secondary` (neutral), `.btn-yellow`, `.btn-danger` (outline rose), `.show-btn`/`.data-search-btn` (compact). Verb+object labels.
- **Cards**: `.card`, `.metric-card`, `.home-panel` — bg-0 + border + r-lg. No nested cards.
- **Tables**: `.data-table` — sticky header on bg-1, hover-row, monospace numeric cells, semantic color on CPL/ROAS.
- **Modals**: unified `.md-*` framework (`.md-bg/.md-card/.md-hd/.md-body/.md-ft/.md-input`, sm/lg sizes). Backdrop `#00000055`. Modals used sparingly — prefer inline.
- **Nav**: 220px sidebar, grouped (`.nav-group`), active = red left-stripe + `#fff5f5` tint. Mobile → slide-out drawer + hamburger top bar.
- **Toggles/dots/badges**: status dots (`.dot.on/.warn`), toggle switch (`.ts-*`), alert badges (high/med/low).
- Focus: `:focus-visible` → 2px red outline, 2px offset, on all interactive elements.

## Layout
- App shell: `#sidebar` (220px, fixed) + `#main` (flex column). Pages are `.page` containers, one active.
- Page header pattern: `.page-header` (title + sub). Toolbars below, content scroll area, footer/pagination pinned.
- Responsive is **structural**: ≤768px sidebar→drawer, master-detail splits stack, 2-col grids→1-col, drawers full-width. Type stays fixed (no fluid scaling).
- z-index scale: dropdowns < sticky headers < drawer overlay (110) < drawer (115) < modals (200–300).

## Motion
- 150–250ms transitions on hover/focus/state. Ease-out. No page-load choreography, no decorative motion.
- `prefers-reduced-motion`: crossfade/instant fallback.
