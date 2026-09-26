# Desktop shell patterns

Notes from Apple's Human Interface Guidelines, Microsoft's Fluent/WinUI
guidance, the GNOME HIG, and the shells of Finder, Codex, Xcode, Notes, VS Code
and Linear. Each section ends with what Deckpress does about it. Quotes are
from the vendor documents as read in September 2026.

## The frame is one band, split at the sidebar edge

Every modern macOS document window (Finder, Notes, Mail, Xcode, Codex) uses a
full-height sidebar. The sidebar column runs from the top edge of the window to
the bottom, and the title bar is split into two segments that line up with the
sidebar boundary. The traffic lights and sidebar-related controls sit in the
sidebar segment; the view title and the view's actions sit in the content
segment. AppKit calls the divider `NSToolbarItem.Identifier.sidebarTrackingSeparator`,
and Big Sur made this the standard look (WWDC20 "Adopt the new look of macOS").

Apple's toolbar guidance: "In a macOS app, the toolbar resides in the frame at
the top of a window, either below or integrated with the title bar. Note that
window titles can display inline with controls, and toolbar items don't include
a bezel." Two toolbar styles matter:

- `.unified`: 52 pt tall, larger controls, inline title at the leading edge of
  the content segment. Finder, Safari and Codex use this.
- `.unifiedCompact`: about 38 pt, regular controls. Meant for windows where
  "the focus should be on the content and there aren't many elements in the
  toolbar".

Windows (Fluent): the standard title bar is 32 px, and "increase the size of the
title bar to 48px when you include a searchbox". Caption controls (minimize,
maximize, close) stay anchored on the right, full-bleed backplates, 16 px
glyphs. All empty space must drag the window; double-click toggles maximize;
right-click shows the system menu.

GNOME: header bars are about 46 px, hold "a small number of controls", arrange
them "according to the three alignment points, left, center and right", and
"the content of header bars can, and should, update along with view or mode
changes". Header bar buttons appear without a visible background or border.

Deckpress: the shell is a two-column grid. The sidebar column is full height
and hosts the traffic lights (macOS) and the sidebar toggle. The content column
starts with a toolbar of the same height that carries the view title and the
view's own controls. The bar is 52 px on macOS to match the unified toolbar
and the traffic-light inset, 46 px on Linux and Windows (between GNOME's 46
and Fluent's 48-with-search). Every non-interactive pixel of both segments is a
drag region.

## Titles: inline, short, never the app name

Apple: "Don't title windows with your app name. Your app's name doesn't provide
useful information about your content hierarchy." Titles should be "under 15
characters" and can sit "inline with controls" at the leading edge. Codex shows
a small glyph plus the session title; Finder shows the folder name after the
back/forward pair.

Deckpress: the toolbar's leading group is the back button (only inside a deck),
then the view title in 13 px medium weight, then a muted count ("14 decks",
"60 cards"). No app name, no logo, no breadcrumbs. The route hierarchy is only
two levels deep (Decks > deck), so back plus title is enough; Apple recommends
the standard back button rather than a breadcrumb for this depth.

## Actions belong to the view, not the app

Apple: "Provide actions that support the main tasks people perform" and "Only
specify one primary action, and put it on the trailing side of the toolbar."
GNOME says the same about context: header bar controls must be "relevant to the
current context". Finder swaps its toolbar between folders (view options, share,
tags); Codex swaps between chat and settings; Xcode changes the run controls per
scheme.

Grouping, per Apple: leading edge for navigation and sidebar toggle, center for
view-level controls (Finder's view switcher, Xcode's scheme picker), trailing
edge for actions, an optional search field and a More menu. Aim for "a maximum
of three" groups, and "prefer simple, recognizable symbols for items instead of
text, except for actions like edit that aren't well-represented by symbols".

Deckpress: each page renders its own toolbar contents into the shared bar.

| Route        | Leading                          | Center                                  | Trailing                                             |
| ------------ | -------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| Decks        | Decks · count                    |                                         | search, restore backup, **New deck**                 |
| Deck         | back, name, format, card count   | Deck editor / Art studio / Print setup  | save state, **Save**, back up, deck settings         |
| Print jobs   | Print jobs · active count        |                                         | refresh                                              |
| Art sources  | Art sources                      |                                         |                                                      |
| Settings     | Settings                         |                                         | open data folder                                     |

Bold marks the single prominent action per view. The old always-present
"New deck / Print jobs / Settings" buttons are gone from the bar; the sidebar
already navigates there, and a bar that never changes tells the user nothing
about where they are.

## Search sits in the bar and has a scope

Apple: "If search is important, give it a primary position in your app or
view", "clearly display the current scope of a search" with descriptive
placeholder text, and put the optional search field on the trailing edge.
Finder's search is the rightmost toolbar item. Fluent puts a global search box
centered in a 48 px title bar. GNOME hides search behind Ctrl+F and a header bar
toggle unless "search is particularly important to your app", in which case
"the search entry can be located elsewhere and made to be permanently visible".

Deckpress: the Decks page keeps a permanent search field in the bar with the
placeholder "Search decks, formats, cards" so the scope is explicit. Cmd/Ctrl+F
focuses it. Deck-level search (the art picker) stays inside the content because
its scope is the card, not the library. There is no global search: with two
levels of hierarchy, a scoped field beats a command palette.

## Sidebar: sections with short labels, two levels, hideable

Apple: "In general, show no more than two levels of hierarchy in a sidebar",
"use succinct, descriptive labels to title each group", "consider letting people
hide the sidebar" with a show/hide button, and "avoid putting critical
information or actions at the bottom of a sidebar. People often relocate a
window in a way that hides its bottom edge." Row metrics come from the system
sidebar size setting: small 24 pt rows with 11 pt text, medium 28 pt / 13 pt,
large 32 pt / 15 pt. Sidebar icons are SF Symbols tinted with the accent color.

Fluent NavigationView: a pane with menu items, separators, group headers, an
optional search box, footer items, and a Settings entry pinned at the bottom.
It collapses to icons (LeftCompact) or a hamburger (LeftMinimal) as the window
narrows.

GNOME: "Order the list according to what is most useful", and "sidebars which
contain a large number of dynamic items will often need to be ordered so that
recently updated items are at the top of the list."

Finder groups rows under "Favorites", "Locations" and "Tags". Codex puts
top-level actions first (New chat, Pull requests, Scheduled, Plugins), then a
"Projects" group whose children are recent sessions, indented, without icons.
Linear and Slack do the same: a static section of destinations, then a dynamic
section of recent items.

Deckpress sidebar, top to bottom:

1. New deck. A quick action row with a plus glyph at the trailing edge, Codex
   style. Cmd/Ctrl+N does the same thing.
2. Library group: Decks, Print jobs (with an in-progress count), Art sources.
3. Recent decks group: the six most recently edited decks as indented rows
   without icons, matching Codex's nested sessions. The open deck is
   highlighted. This is the second and last level of hierarchy.
4. Footer: Settings, and an engine notice that only appears when the engine
   failed to start. Nothing else lives at the bottom.

Rows are 28 px with 13 px text (macOS medium). Icons are 16 px, muted at rest
and accent-tinted on the selected row; with five destinations, tinting every
icon in the accent reads louder than Finder's blue because Deckpress's accent is
a warm gold. Group labels are 11 px semibold, sentence case, muted. Cmd/Ctrl+B
toggles the sidebar (VS Code, Xcode's Cmd+0 and Codex all bind a sidebar
toggle); the state persists across launches.

## Window state and materials

Apple: key, main and inactive windows must look different; inactive windows
lose vibrancy. Fluent: "all title bar elements should be semi-transparent when
the window is inactive." Apple also asks apps to "reduce the use of toolbar
backgrounds and tinted controls" and to let the content layer inform the bar.

Deckpress: the sidebar and both bar segments share one flat surface color one
step darker than the content, with a single hairline between sidebar and
content. Toolbar buttons have no border or background at rest, per both Apple
and GNOME. When the window loses focus, the bar and sidebar text drop to 60 %
opacity, driven by the Tauri focus event.

## Keyboard

Apple: "Make every toolbar item available as a command in the menu bar",
because people can hide or customize the toolbar. Deckpress does not yet ship a
native menu, so the equivalents are keyboard shortcuts with `aria-keyshortcuts`
on the controls and the shortcut in each tooltip:

| Shortcut       | Action                          |
| -------------- | ------------------------------- |
| Cmd/Ctrl+B     | Show or hide the sidebar        |
| Cmd/Ctrl+N     | New deck                        |
| Cmd/Ctrl+F     | Focus the Decks search          |
| Cmd/Ctrl+S     | Save the open deck              |
| Cmd/Ctrl+,     | Settings (macOS convention)     |

## Platform chrome

- macOS: `titleBarStyle: Overlay`, `hiddenTitle: true`, traffic lights moved to
  x 20 / y 28 so they center in the 52 px bar (values from a Tauri unified
  toolbar study; they need a check on real hardware). The sidebar segment pads
  84 px on the left so nothing sits under the lights; when the sidebar is
  hidden the padding moves to the content bar. In full screen the lights hide,
  so the inset drops to zero.
- Windows and Linux: system decorations are off and the app draws minimize /
  maximize / close as 46 px wide full-bleed buttons on the right, Fluent style,
  with the red close hover. `DECKPRESS_NATIVE_DECORATIONS=1` restores the
  native frame. Double-clicking empty bar space toggles maximize (Tauri's drag
  region does this).

## Things we deliberately did not copy

- Toolbar customization and a More menu (Apple). With at most four items per
  view there is nothing to hide.
- A global command palette (VS Code, Linear). The hierarchy is two levels deep.
- Sidebar icon tinting on every row (Finder). See above.
- Liquid Glass materials. The webview cannot sample the desktop behind the
  window without private APIs.
