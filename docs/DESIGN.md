# Neritium — interface direction: "Sleeve"

Neritium plays a library you own (device storage, self-hosted server), not a rented
catalogue. The interface therefore borrows from the object that library is made
of: the record sleeve. Sleeves have spines, printed tracklists, and a visible
edge where the disc sits inside.

## Signature

**The sleeve edge** — a 3px strip that carries the current cover art at the one
place the layout already draws a boundary: the inner edge of the desktop
navigation spine, and the top edge of the mobile dock. It encodes state rather
than decorating: solid while playing, dimmed while paused, absent when idle.

Everything else stays quiet so the edge is the one thing you remember.

## Color

Signal color is the existing brand accent (user-selectable, default violet). It
is used **only** for state — playing, selected, focus ring — never for decor,
never in gradients. Surfaces are cool graphite neutrals: the paper stock, not a
mood.

| role | light | dark |
| --- | --- | --- |
| canvas (app bg) | `#dcdad5` | `#101014` |
| surface (cards) | `#fdfcfa` | `#191920` |
| panel (insets) | `#e7e4de` | `#242430` |
| text primary | `#16151a` | `#f4f3f8` |

## Type

- **UI**: Geist (already global via `--font-inter`) — one family, four weights.
- **Catalogue**: Geist Mono for track numbers, durations, counts. These are
  catalogue data on a real sleeve; mono is the one place it belongs.
- Scale: 44/32/22/15/13/11. No display face: the cover art is the display.

## Layout

```
desktop ≥900px                      mobile <900px
┌──┬─────────────────────────┐      ┌─────────────────────────┐
│S │                         │      │                         │
│p │      content card       │      │      content card       │
│n │                         │      │                         │
│e │                         │      │                         │
│  ├─────────────────────────┤      ├─────────────────────────┤
│▐ │      mini player        │      │      mini player        │
└──┴─────────────────────────┘      ├─────────────────────────┤
   ▲ sleeve edge                   │  dock: 5 targets (44px) │
                                   └─────────────────────────┘
                                      ▲ sleeve edge on top
```

- One breakpoint (900px) because that is where a 60px spine plus a readable
  content column stops fitting. Everything else is fluid.
- Mobile navigation must be thumb-reachable: a bottom dock, not a hover rail.
- No hover-only information anywhere — every rail item carries an accessible
  name.

## Motion

One curve (`--motion-ease`) and two durations: 150ms for state, 280ms for
surfaces. No scroll reveals, no entrance choreography, no parallax. Reduced
motion disables page transitions and the sleeve edge fade.

## Component rules

- Radius: `12px` controls, `16px` cards, `24px` content surface. Nothing else.
- Border, not shadow, for in-place grouping; elevation only for floating layers.
- Empty and error states state what happened and what to do next.
- Glass surfaces only ever sit over live artwork (fullscreen player), never over
  flat UI.
