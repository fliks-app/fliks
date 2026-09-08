# Plan — the library grid scrolls its own container instead of the window

Status: **proposed**, not started. Written 2026-09-08, out of the iOS debugging
session that produced #1321 and #1322.

Goal: the library grid's scroll offset becomes a property of its own element
instead of a property of the window. That one change removes four separate
workarounds that all exist to paper over the same structural fact, and it is a
precondition for the last unexplained artifact in that session.

Non-goals (this plan): moving any other page off document scroll, touching the
CDK dependency or the virtualisation itself, and fixing the blank
view-transition frame — the last one is *enabled* by this work but not proven to
be caused by document height (see "What this does not promise").

## Why — the structural fact

The grid is declared as `<cdk-virtual-scroll-viewport scrollWindow>`
(`client/src/app/features/library/library.html:387`). `scrollWindow` is a CDK
**opt-in** (`CdkVirtualScrollableWindow`, selector
`cdk-virtual-scroll-viewport[scrollWindow]`) that hands the scrolling job to the
window. Three consequences follow, and every bug below is one of them:

1. The document becomes as tall as the whole virtual list — measured at
   **47 575 px** on the Films library.
2. The grid's position is not stored anywhere in the grid. It lives on the
   window, which is shared with every other page.
3. Therefore anything that cares about the position has to listen to `window`,
   including while the page is not the one on screen.

Point 2 is the expensive one, because the library route is `reuse: true`: its DOM
is **detached from the document** and parked in the reuse cache instead of
destroyed. Its element-level state survives that trip perfectly. Its
window-level state does not survive it at all — and worse, keeps changing behind
its back.

### What that cost us, measured

All four were reproduced on a physical iPhone XS by streaming the WebView
console over `devicectl --console`. Each is now fixed in #1322 by a workaround,
and each workaround exists **only** because of point 2:

| Symptom | Mechanism | Workaround in #1322 |
| --- | --- | --- |
| The whole grid reloads its artwork on every return (36 posters) | The page detaches → the document shrinks to the detail page → the offset clamps to 0 → the detached viewport's window-scroll subscription fires → CDK re-ranges the grid onto `0-7` and drops the 12 rows on screen, which the return then rebuilds | `suspendRanging()` overwrites `_scrollStrategy.onContentScrolled` — a **CDK internal** |
| The A-Z index reads `A` before jumping to the right letter | Same clamp. `onLetterScroll` derives the letter from the window offset and computed row 0 | The listener is removed for the trip and recomputed on return |
| Rows have to be re-rendered before the scroll can be restored | The restored offset and the rendered range disagree at reattach, so the poster morph has no card to fly home to | `prerenderRestoredRows` + `renderRowsForOffset`, including a second CDK internal, `_doChangeDetection` |
| The grid flashes the top of the list mid-transition | `renderRowsForOffset` handed the offset back to 0 and CDK re-picked the top on the frame before the restore landed | The offset is kept instead of handed back |

Four workarounds, two of them reaching into CDK privates. None of them is wrong;
all of them are downstream of one declaration.

### Why the same code is fine on Android

Everything in this plan was **observed only on iOS**, and that is worth stating
precisely, because the reason differs per item — two are genuinely WebKit-only
and two are cross-platform bugs that Android merely hides:

**WebKit-only, by mechanism:**

- **The dropped scroll.** `window.scrollTo({top: 0})` is silently ignored while
  WKWebView is still settling its scroll view's `contentSize`. Measured: the
  router called it at `y=1422 max=1422` and the page stayed at 1422, then
  drifted to its own bottom. Chromium applies it. This is why #1322 had to take
  the scroll job away from the router.
- **The compositor showing an intermediate offset.** iOS scrolling is handled
  off the main thread, so a 0 → offset round trip inside one task can still be
  composited at 0. On Chromium the same two calls coalesce.

**Cross-platform, masked on Android:**

- **The range collapse.** The document shrinking and clamping the offset to 0 is
  plain web behaviour; the detached viewport re-ranges on Chromium too. Android
  hides the *consequence*: a re-created `<img>` is served instantly from the
  WebView's HTTP cache, so `imgLoaded` flips back within the frame and the
  placeholder is never seen. On iOS the same URL is
  `capacitor://localhost/_capacitor_file_/…`, served by Capacitor's custom
  scheme handler, which does not benefit from that memory cache — so every
  re-created card visibly re-decodes.
- **The A-Z letter.** Nothing platform-specific at all. It very likely misreads
  on Android too and simply was not noticed.

So: iOS is where this is *visible*, not where all of it is *wrong*. Two of the
four fixes benefit Android silently.

## What this buys

**Deleted outright:**

- `suspendRanging` / `resumeRanging` / `scrollStrategy()` in `library.ts`,
  including the write over `_scrollStrategy.onContentScrolled`. A container
  scroller emits no events while detached — its `scrollTop` simply does not
  change — so there is nothing to mute.
- `prerenderRestoredRows` in `library.ts` and the whole
  `client/src/app/shared/utils/restore-virtual-rows.ts` helper (its only caller
  is the library) plus its spec, including the write over `_doChangeDetection`.
  The rendered rows and the offset can no longer disagree, because the offset
  never moved.
- The library's participation in `ScrollMemoryService`: no `scrollKey`, no
  `remembered`, no `restoreSticky` for this page. `scrollTop` on a detached
  element is preserved by the DOM. The service stays for the pages that really
  do scroll the document.
- The library's own `window` scroll listener for the alphabet, in favour of one
  on the container that cannot fire for a page nobody is looking at.

**Gained for free from CDK's default mode:** `.cdk-virtual-scrollable` ships
`overflow: auto; contain: strict; overflow-anchor: none`. That
`overflow-anchor: none` is exactly the scroll-anchoring protection the window
mode cannot give us, because in that mode the scroller is `html`, out of reach
of the rule.

**Made possible:** the document stops being 47 575 px and becomes viewport-sized.
That is also precisely what the comment at `client/src/styles.css:1219` was
trying to buy by disabling the root cross-fade ("Rasterizing + compositing two
viewport-sized `root` snapshots is the heaviest part of every view-transition on
weak GPUs").

## Decisions taken

- **Library only.** `cdk-virtual-scroll-viewport` has exactly one consumer in
  the codebase (`library.html`), so the CDK half of this is confined to one
  page. Home, search, playlists and watch-history keep document scroll and are
  untouched.
- **`infinite-scroll-list` is not migrated.** It has two consumers, `library`
  and `persons` (`persons.ts:66` is the only `trackScroll` caller). The library
  does not use `trackScroll` — it drives its own `onLetterScroll` — so nothing
  in the shared helper has to change for this plan. Persons keeps document
  scroll.
- **`layout` gets an indirection, not a rewrite.** It must keep working on both
  scroll models, because after this plan both exist.
- **No `overflow-x: hidden` anywhere new.** It coerces `overflow-y` to `auto`
  and silently creates a second scroller — the trap `layout.html:156` already
  documents for `<main>`.
- **The alphabet column stays `position: fixed`.** It is nailed to the viewport
  on purpose (`library.html:292`) and is not inside the scroller.

## Phase 0 — the scroller indirection (ship first, safe on its own)

Nothing about the library yet. This phase is a no-op in behaviour and can merge
and sit on `main` independently.

### 0.1 A service that answers "what scrolls the current page"

New `client/src/app/core/services/page-scroller.service.ts`:

- `readonly element = signal<HTMLElement | null>(null)` — null means the
  document.
- `claim(el: HTMLElement)` / `release(el: HTMLElement)`, with the same
  same-owner guard as `ScrollMemoryService.clear` so a page navigated away from
  cannot wipe the claim of the page navigated to.
- `offset(): number` → `element()?.scrollTop ?? window.scrollY`.
- `scrollTo(top: number)` → the right target.
- `changes(): Observable<void>` (or an `addListener` pair) that attaches to
  `element() ?? window` and re-attaches when the claim changes.

Cleared on `NavigationEnd` unless re-claimed, so a page that forgets to release
cannot poison the next one.

### 0.2 `layout` reads through it

`layout.ts:205` `onScroll` and `layout.ts:212` `readScroll` currently read
`window.scrollY` for the topbar condense/hide. Route both through
`PageScrollerService`, and subscribe to `changes()` instead of binding `window`
directly at `layout.ts:311`.

`watchTopSentinel` (`layout.ts:225`) needs its `IntersectionObserver` to take
`{ root: pageScroller.element() }` — with a container scroller, a viewport-rooted
observer never intersects. Re-create the observer when the claim changes.

### 0.3 `settings-drawer` reads through it

`settings-drawer.ts:61` duplicates the same topbar-hide logic off
`window.scrollY`. Same treatment. (Worth noting as a pre-existing duplication;
not this plan's job to merge them.)

### 0.4 Tests

Unit-test the service: claim/release ordering, the same-owner guard, that
`offset()` and `changes()` follow the claim, and that a `NavigationEnd` with no
claim falls back to the document.

## Phase 1 — the library grid becomes its own scroller

The scroller is the page shell (`.library-shell`), not the CDK viewport — the
whole page (title, tabs, filters, grid, legend) scrolls together, exactly as it
did on the document, just with the offset living on an element instead of
`window`.

### 1.1 Bound the page shell, not the grid row

The page shell (`.library-shell`, `library.html:5`) is the element that becomes
the scroller: `html.page-owns-scroll .library-shell` (`styles.css:706`) gives it
`overflow: hidden auto` plus a bounded height (`flex: 1; min-height: 0`), a
horizontal bleed out of `<main>`'s own padding so its scrollbar clears the fixed
alphabet column, and the padding re-applied inside for the cards' focus-lift
overflow. The grid row and the CDK viewport underneath stay their natural
height — no `flex-1 min-h-0` on either — because the viewport is no longer the
scroller; the shell is.

`min-h-0` on every ancestor **above** the shell (`.drawer`, `.drawer-content`,
`main`, `app-library`) is still the part that silently fails if missed: a flex
child defaults to `min-height: auto` and refuses to shrink, so an ancestor grows
to its content and the *document* scrolls again — reintroducing the whole bug
with no error.

### 1.2 Swap `scrollWindow` for `cdkVirtualScrollingElement` on the shell

Remove `scrollWindow` (`library.html:387`). In its place, `cdkVirtualScrollingElement`
(`CdkVirtualScrollableElement`, selector `[cdkVirtualScrollingElement]`) goes on
`.library-shell`, not the viewport — CDK's other opt-in mode, which puts the
scroller on an ancestor instead of the viewport itself. Add
`CdkVirtualScrollableElement` to the component's `imports` array
(`library.ts:55`) alongside `CdkVirtualScrollViewport` / `CdkVirtualForOf`.

With a `VIRTUAL_SCROLLABLE` ancestor present, the viewport itself never adds
`.cdk-virtual-scrollable` (`overflow: auto; contain: strict`) — it stays
`display: block; position: relative` at full content height, same as the old
`scrollWindow` mode, but now delegating to the shell's `scrollTop` instead of
`window`. Keep `class="flex-1 min-w-0 library-viewport"`, drop the `h-full` the
first draft of this plan added (the viewport is unbounded again) and the
now-dead scrollbar-clearance margin binding that only mattered when the
scrollbar drew on the viewport itself.

Keep `.library-viewport .cdk-virtual-scroll-content-wrapper { contain: none }`
(`styles.css:679`) — confirmed still needed: the viewport itself never clips in
either mode, so CDK's content wrapper (`contain: content`) is the only thing
that would still trap the focus ring / D-pad scale-up outside a row.

### 1.3 Claim the scroller

The claim targets the shell element, not the viewport's — `pageScroller.claim(this.shellRef.nativeElement)`
(a `@ViewChild('shell', { static: true })` on the root div), released in
`ngOnDestroy` and on `onDetach`, re-claimed on `onAttach`. It stays gated on the
existing `@ViewChild(CdkVirtualScrollViewport)` setter (i.e. only claimed while
a viewport exists), because `.library-shell` wraps all five view modes and only
`all` has one — the other four tabs keep scrolling the document, topbar hide
included.

### 1.4 The alphabet reads the container

`onLetterScroll` binds to the shell, not the viewport's element. Its body is
unchanged: `viewport.measureScrollOffset()` still returns a content-relative
offset in ancestor-scrollable mode too — CDK's own implementation delegates to
`this.scrollable.measureScrollOffset(from) - this.measureViewportOffset()`,
where `scrollable` is the shell and `measureViewportOffset()` is the (zero, here)
distance between the viewport's box and the shell's — so the rect maths still
disappears, just resolved through the ancestor instead of `this`.

### 1.5 Delete the workarounds

In `library.ts`: `suspendRanging`, `resumeRanging`, `scrollStrategy`,
`prerenderRestoredRows`, the `onDetach`/`onAttach` bodies that called them, and
the `scrollKey` passed to `keepRouteFresh`. Delete
`shared/utils/restore-virtual-rows.ts` and its spec.

Keep `keepRouteFresh` itself — `refresh`, `setPageTitle` and `applyBackground`
are still wanted on return.

### 1.6 TV

`scroll-padding-top: 96px` / `scroll-padding-bottom: 20vh` are set on
`html.tv-host` (`styles.css:438`). Scroll padding applies to the **scroll
container**, which is now `.library-shell`, not the viewport — moved there
(`styles.css:718`), or D-pad `scrollIntoView({block: 'nearest'})` parks the
focused card flush against the shell's edge. The spatial-nav calls themselves
(`tv-spatial-nav.service.ts:337`, `focusable.constants.ts:58`) need no change —
`scrollIntoView` walks to the nearest scrollable ancestor.

`scroll-behavior: smooth` moves with it, onto `html.tv-host .library-shell`: the
viewport itself carries no `.cdk-virtual-scrollable` class in ancestor mode (it
never becomes a scroller), so there is nothing on the viewport for that rule to
apply to anymore.

### 1.7 Tests

The existing library specs cover row chunking and letter maths; extend for the
container:

- The active letter is derived from `measureScrollOffset()`.
- A detach/attach cycle leaves the rendered range and `scrollTop` untouched
  (this is the regression test for the whole plan — it should pass trivially,
  which is the point).

## Phase 2 — reconsider the view-transition root suppression

Only after Phase 1, and only with a measurement in hand.

With a viewport-sized document, re-test whether
`::view-transition-old(root), ::view-transition-new(root) { animation: none }`
(`styles.css:1225`) is still needed at all, or whether the real cross-fade is now
affordable — including on TV, which is what motivated it. If the blank frame
reported in #1322 was a snapshot-size problem, this is where it disappears; if
it survives a viewport-sized document, the hypothesis is dead and the
investigation moves elsewhere.

Do not bundle this into Phase 1. It is a separate question with a separate test.

## What this does not promise

- **The blank frame is not diagnosed.** The per-frame trace in #1322 proves the
  live DOM is intact throughout the back transition — scroll already restored,
  15 cards in the viewport, constant across 20 sampled frames — so the blank is
  in the pseudo-element tree. A `mix-blend-mode` hypothesis was tested on device
  and disproved. Document height is the next suspect, and this plan removes it
  as a variable. That is not the same as fixing it.
- **Nested-scroller feel on iOS.** Momentum, rubber-band and the scroll-to-top
  status-bar tap behave differently in a container than on the document. This
  needs a device pass, and it is the one risk that no amount of static reasoning
  settles.
- **Two scroll models coexist** after this plan (library on a container,
  everything else on the document). That is a real complexity cost. Phase 0
  exists to make it survivable by giving the shared consumers one API instead of
  two code paths.

## Phases and effort

| Phase | Scope | Risk |
| --- | --- | --- |
| 0 — scroller indirection | new service, `layout`, `settings-drawer` | low, behaviour-neutral, ships alone |
| 1 — library on a container | `library.html` / `library.ts`, deletes 4 workarounds + 1 helper | medium, needs iOS + Android + TV passes |
| 2 — root snapshot | one CSS rule, measured | low, gated on a measurement |

## Open questions

- Does the status-bar tap-to-top still work on iOS with a container scroller? If
  not, is that acceptable on this page?
- Should `persons` follow later for consistency, or is document scroll the right
  default for every non-virtualised list?
- `attached$` fires twice per return (Angular calls `retrieve()` twice), so
  `refresh()` and its HTTP revalidation run twice on all six cached pages.
  Unrelated to this plan and untouched by it, but it is the other finding from
  the same session and deserves its own fix.
