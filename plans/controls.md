# Audit & règles du système de contrôle (Desktop / Mobile / Tablet / TV)

## Context

Les commits récents (`551f1eaf` "force desktop layout on TV", `bf96e791` "robust D-pad nav") ont durci la détection TV pour offrir une vraie 10-foot UI sur Android TV. **Effet de bord**: la détection TV au bootstrap est trop large et capture les tablettes Android en paysage. Conséquence concrète: sur tablette, l'app pense être une TV, applique le mode D-pad et casse les contrôles tactiles (overlay tap-to-show, sheets, hover overlays, etc.). L'utilisateur signale "contrôles plus accessibles sur tablette Android".

But du plan: 1) figer des **règles claires** pour chaque form-factor, 2) corriger la détection pour qu'elle ne soit jamais ambiguë, 3) corriger les régressions tablette. Pas de gros refactor, on garde la logique existante mais on la canalise dans une seule source de vérité.

---

## 1. Le modèle: input + form-factor (deux axes orthogonaux)

Le problème actuel vient de la fusion de deux concepts dans `isTv` / `isMobileTouch`. On les sépare:

**Axis A — modalité d'input (comment on interagit)**
- `mouse` — pointeur fin, hover possible
- `touch` — pointeur grossier, pas de hover
- `dpad` — clavier directionnel uniquement, focus visible obligatoire

**Axis B — form-factor (comment on dessine)**
- `desktop` — sidebar pinned, dropdowns, pas de bottom sheets
- `phone` — bottom navbar, bottom sheets, contrôles compacts
- `tablet` — bottom navbar, bottom sheets, contrôles **plus larges** (espace dispo)
- `tv` — sidebar pinned, dropdowns desktop, focus ring, font +18px

Les deux axes ne sont **pas** corrélés 1-pour-1: une tablette en mode bureau Bluetooth = `mouse + tablet`, une TV avec souris = `mouse + tv` (rare mais ok), un tablet seul = `touch + tablet`.

### Matrice cible des comportements

| | Desktop | Phone | Tablet | TV |
|---|---|---|---|---|
| Détection canonique | `pointer: fine` | `pointer: coarse` ∧ vw<768 | `pointer: coarse` ∧ vw≥768 | UA `AndroidTV/\d` ∨ `pointer: none` |
| Sidebar gauche | pinned ≥lg | drawer (hamburger) | drawer (hamburger) | pinned (D-pad-friendly) |
| Bottom navbar | non | oui | oui | non |
| Player layout | desktop | mobile | mobile (boutons agrandis) | desktop |
| Show controls | `(mousemove)` | tap centre | tap centre | focus / D-pad / Back |
| Auto-hide controls | 3s en lecture | 3s en lecture | 3s en lecture | 5s en lecture |
| Focus ring fort | non | non | non | **oui** |
| Hover overlay sur cards | oui | non | non | non (focus ring à la place) |
| Card actions | hover + click | long-press 500ms | long-press 500ms | bouton MENU / contextuel |
| Spatial nav (arrows) | off | off | off | **on** |
| Keyboard shortcuts player | on | off (pas de kb) | optionnel (kb BT) | seekbar owns ←→ |
| Drag-to-dismiss sheet | n/a | oui (touch) | oui (touch) | n/a |

### Règle d'or
> **`isTv` ne doit jamais être vrai sur un appareil tactile sans D-pad.** Si on n'est pas sûr, on est `tablet`, pas `tv`. Une TV mal détectée → utilisateur peut basculer manuellement; une tablette mal détectée en TV → totalement bloqué.

---

## 2. Cause racine du bug tablette

**Fichier**: `frontend/src/main.ts:14-20`

```js
const noFinePointer = !!matchMedia && matchMedia('(any-pointer: fine)').matches === false;
const wideLandscape = window.screen.width >= 1280 && window.screen.width >= window.screen.height;
const isTv =
  /AndroidTV\/\d/.test(ua) ||
  (matchMedia && matchMedia('(pointer: none)').matches) ||
  /Android.*TV|BRAVIA|SHIELD|AFT[A-Z0-9]+|GoogleTV/i.test(ua) ||
  (isAndroid && wideLandscape && noFinePointer);   // ← faux positif tablettes
```

Un iPad/Galaxy Tab/Pixel Tablet sans stylet en paysage match `noFinePointer && wideLandscape` → `isTv=true`. À partir de là:
- `body.tv` posée → CSS 10-foot UI (focus rings, scale, hover désactivé) — `frontend/src/styles.css:122-183`
- `TvSpatialNavService.bind()` → arrow keys piégées au cas où — `tv-spatial-nav.service.ts:27`
- `PlayerControlsComponent.isMobileTouch = isNative && !isTv` → `false` → layout desktop, pas de tap-overlay, pas de bottom sheets — `player-controls.ts:79`
- `layout.html:204` `[class.hidden]="isNative && !tv.isTv()"` → sidebar **shown** mais pas de hamburger touch-friendly visible (line 21: `!isNative || tv.isTv()` → menu visible mais le drawer est pinned)
- Card hover overlay caché (`@if (!isNative)` dans media-card) → pas de bouton play tap

⇒ Sur tablette, les contrôles existent mais sont **tous gérés comme si on avait un D-pad**, donc inopérants au doigt.

---

## 3. Implémentation proposée

### 3.1 — Source unique de vérité: `DeviceService`

Nouveau service: `frontend/src/app/core/services/device.service.ts` (remplace `tv.service.ts` au point d'usage; on garde `TvService` comme façade rétrocompatible le temps de la migration).

```ts
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly input    = signal<'mouse' | 'touch' | 'dpad'>('mouse');
  readonly formFactor = signal<'desktop' | 'phone' | 'tablet' | 'tv'>('desktop');
  readonly isTv      = computed(() => this.formFactor() === 'tv');
  readonly isTablet  = computed(() => this.formFactor() === 'tablet');
  readonly isPhone   = computed(() => this.formFactor() === 'phone');
  readonly isTouch   = computed(() => this.input() === 'touch');
  // ...
}
```

Détection (idem ordre de confiance, mais **sans** la règle `wideLandscape && noFinePointer`):

| Signal | → résultat |
|---|---|
| UA `AndroidTV/\d` (natif Android TV) | `dpad + tv` |
| `matchMedia('(pointer: none)')` | `dpad + tv` |
| UA contient `BRAVIA\|SHIELD\|AFT[A-Z0-9]+\|GoogleTV` ET natif Android | `dpad + tv` |
| `?tv=1` query param (override dev) | `dpad + tv` |
| `matchMedia('(pointer: coarse)')` ET vw < 768 | `touch + phone` |
| `matchMedia('(pointer: coarse)')` ET vw ≥ 768 | `touch + tablet` |
| Sinon | `mouse + desktop` |

Le `body.tv` reste le mécanisme CSS, on ajoute en parallèle `body.tablet` et `body.phone` (bonus: certains styles cassent moins).

### 3.2 — Fichiers à modifier

1. **`frontend/src/main.ts`** — supprimer la branche `wideLandscape && noFinePointer`. Ne poser `body.tv` que sur les 4 premiers signaux (UA TV, `pointer: none`, sniff TV-only, `?tv=1`).
2. **`frontend/src/app/core/services/tv.service.ts`** — devient un wrapper qui lit `DeviceService.isTv()`. (Migration douce: tous les consumers existants continuent à marcher.)
3. **`frontend/src/app/core/services/device.service.ts`** — nouveau, voir 3.1.
4. **`frontend/src/app/features/player/controls/player-controls.ts:79`** — remplacer
   ```ts
   readonly isMobileTouch = computed(() => this.isNative() && !this.isTv());
   ```
   par
   ```ts
   readonly playerLayout = computed<'desktop' | 'mobile' | 'tv'>(() => {
     if (this.device.isTv()) return 'tv';
     if (this.device.isTouch()) return 'mobile';
     return 'desktop';
   });
   readonly isMobileTouch = computed(() => this.playerLayout() === 'mobile');
   ```
   ⇒ aucune ligne de template à toucher (`isMobileTouch()` reste valide), mais corrige la tablette.
5. **`frontend/src/app/features/player/player.html:9`** — accepter aussi le `pointermove` côté natif tactile (pour réveil sur tablette en mode native PWA), avec garde:
   ```html
   (pointermove)="device.isTouch() ? null : showControls()"
   (click)="device.isTouch() ? showControls() : null"
   ```
   Le `(click)` redondant rend la zone tappable à coup sûr; les boutons internes ont `stopPropagation`.
6. **`frontend/src/app/features/player/player.ts:962`** — passer le timeout à 5 s en mode TV (focus visible plus long pour D-pad). Réutilise `device.isTv()`:
   ```ts
   const timeoutMs = this.device.isTv() ? 5000 : 3000;
   ```
7. **`frontend/src/app/shared/components/media-card/media-card.html`** — remplacer `@if (!isNative)` par `@if (device.input() === 'mouse')` pour l'overlay de hover. La tablette tactile n'aura toujours pas l'overlay hover, mais on le rend explicitement par la modalité d'input et pas par une heuristique native. (La tablette utilise déjà le long-press de `card-actions.directive.ts`, c'est OK.)
8. **`frontend/src/app/shared/layout/layout.html:1,204`** — sidebar: pinned uniquement sur **desktop** ou **tv**, drawer (avec hamburger) sur **phone** et **tablet**:
   ```html
   <div class="drawer min-h-screen" [class.lg:drawer-open]="device.formFactor() === 'desktop' || device.isTv()">
   ...
   <div class="drawer-side z-40" [class.hidden]="device.isTouch() && !device.isTv()">
   ```
   Le hamburger (line 22) devient visible quand `device.isTouch() && !device.isTv()` (cohérent: phone + tablet montrent le hamburger).
9. **`frontend/src/app/core/services/tv-spatial-nav.service.ts:27`** — déjà correct (n'agit que si `isTv`). Ne touche à rien après la correction de détection — le service s'arrête tout seul de bind sur tablette.
10. **`frontend/src/styles.css`** — ajouter un bloc `body.tablet` minimal: `[data-touch-only]` reste visible (déjà cas par défaut), bouton `btn-md` au lieu de `btn-sm` pour les contrôles player (les boutons ont la place).

### 3.3 — Dropdowns DaisyUI × TV × focus (réponse à la question d'audit)

> Sur TV, on **réutilise** les dropdowns desktop (subtitles/audio/speed/settings) — c'est la décision du commit `551f1eaf`. Le D-pad doit donc savoir y entrer, naviguer dedans, en sortir, sans "fuir" vers d'autres focusables.

**État actuel** (`player-controls.html:188-248`, `player-controls.ts:148`):
- Ouverture pilotée manuellement par signal `openDropdown` (`'subtitles' | 'audio' | 'speed' | 'settings' | null`) + `[class.dropdown-open]="..."`. Le commit `bf96e791` a remplacé l'ouverture par `:focus-within` natif de DaisyUI pour empêcher le D-pad d'ouvrir un dropdown rien qu'en s'arrêtant dessus.
- Fermeture: clic sur un item appelle `closeDropdown()` ; clic sur le trigger re-toggle ; pas de Escape/Back wired ; pas de fermeture sur clic extérieur (dépend du focus-within, mais qui ne s'applique plus).
- `(mousedown)="$event.preventDefault()"` sur `#settingsMenu` (line 376) garde le focus sur le trigger pendant le clic — utile en souris, sans effet en D-pad.

**3 problèmes concrets sur TV**:
1. **Pas d'auto-focus dans le panneau quand il s'ouvre.** Après Enter sur le trigger, le focus reste sur le bouton; D-pad Down doit traverser via spatial-nav pour atteindre le 1er item — ça marche par chance (la dropdown-content est en `dropdown-top`, donc Down ne va pas vers le haut), mais c'est fragile et lent.
2. **Pas de focus trap.** D-pad Down depuis le dernier item ou Right depuis n'importe quel item peut sortir vers d'autres focusables (le bouton FullScreen, la barre du bas, etc.) — le panneau reste **ouvert visuellement** mais le focus est ailleurs. Confusion garantie.
3. **Pas de Back/Escape.** Le bouton Back du remote Android remonte la stack (player → page média) au lieu de fermer le dropdown. C'est l'UX standard pour les overlays modaux.

**Règle TV pour les dropdowns** (à appliquer dans le même PR):

| Phase | Comportement attendu |
|---|---|
| Ouverture | `(click)` ou Enter sur trigger → set `openDropdown(name)` → **après le rendu**, focus le 1er item de `.dropdown-content` programmatiquement |
| Navigation interne | D-pad Up/Down naviguent dans la liste; spatial-nav `findNeighbor` doit **restreindre les candidats au sous-arbre `.dropdown-content`** quand un dropdown est ouvert |
| Sortie latérale (Right/Left) | bloquée: `inLine`/`offLine` n'incluent que les items du panneau |
| Sélection | `(click)` sur item → emit + `closeDropdown()` → refocus le trigger |
| Fermeture par Back/Escape | global `keydown` listener: si `openDropdown() !== null` ET key `Escape`/`Back`/key code 4 (Android KEYCODE_BACK), preventDefault + `closeDropdown()` + refocus trigger |
| Clic extérieur | overlay invisible `<div class="fixed inset-0 z-30" (click)="closeDropdown()">` injecté quand `openDropdown() !== null` (déjà le pattern utilisé par `bottomMenuOpen` dans `layout.html:141`) |
| Hover-to-open (DaisyUI default) | déjà inerte sur TV (pas de pointer); côté CSS, ajouter `body.tv .dropdown:not(.dropdown-open) > .dropdown-content { display: none !important; }` pour neutraliser le legacy `:focus-within` au cas où DaisyUI le réactiverait dans une future version |

**Implémentation concrète** (~30 lignes):

1. Dans `PlayerControlsComponent`, ajouter une référence au container du panneau actif:
   ```ts
   readonly dropdownPanel = viewChild<ElementRef<HTMLElement>>('dropdownPanel');
   ```
   Et une méthode `openDropdown(name)` qui après `this.openDropdown.set(name)` enchaîne `afterNextRender(() => this.dropdownPanel()?.nativeElement.querySelector<HTMLElement>('button')?.focus())` — uniquement si `device.isTv()`.

2. Dans `TvSpatialNavService.findNeighbor`, gate l'univers de candidats si un panel modal est ouvert:
   ```ts
   const openModal = document.querySelector<HTMLElement>('.dropdown-open .dropdown-content');
   const all = openModal
     ? collectFocusables(openModal)   // restreint au sous-arbre
     : collectFocusables();
   ```
   `collectFocusables` accepte déjà n'importe quel root (signature à étendre).

3. Listener Escape/Back dans `PlayerControlsComponent` (HostListener `'keydown'`):
   ```ts
   @HostListener('window:keydown', ['$event'])
   onKey(e: KeyboardEvent) {
     if (this.openDropdown() && (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 4)) {
       e.preventDefault();
       e.stopPropagation();
       this.closeDropdown();
     }
   }
   ```
   Doit s'exécuter en capture, **avant** que l'OS traite Back côté Capacitor.

4. Backdrop click-out: ajouter dans le template, à côté du panel ouvert:
   ```html
   @if (openDropdown()) {
     <div class="fixed inset-0 z-30" (click)="closeDropdown($event)"></div>
   }
   ```

5. CSS dans `styles.css`:
   ```css
   /* TV: dropdowns ne s'ouvrent que via la classe contrôlée par signal — neutralise
      tout fallback :focus-within de DaisyUI. */
   body.tv .dropdown:not(.dropdown-open) > .dropdown-content {
     display: none !important;
   }
   ```

**Sur les autres form-factors**:
- Desktop: comportement inchangé (click pour toggle, click extérieur via `:focus-within` natif ou nouveau backdrop — pas un retour en arrière).
- Tablet/Phone: les dropdowns ne sont pas utilisés (bottom sheets à la place). Pas de regression.

### 3.4 — Garde-fous nouveaux

- **Test runtime au bootstrap**: log `console.info('[device]', input, formFactor, ua)` dans `DeviceService.constructor()` — invisible en prod mais aide énormément à diagnostiquer en debug Chrome distant.
- **Override URL**: `?tv=1` force TV, `?tablet=1` force tablet, `?phone=1` force phone (pour tester sans changer d'appareil). À placer dans `localStorage` pour persister.
- **Re-évaluation sur resize**: si l'utilisateur tourne la tablette (portrait ↔ paysage), recalculer `formFactor` pour mettre à jour `phone ↔ tablet` à la limite des 768 px.

---

## 4. Vérification (test plan)

À jouer sur 4 cibles:

### Desktop (Chrome web)
1. Ouvrir l'app → `body` n'a ni `.tv` ni `.tablet`. Sidebar pinned à ≥1024 px.
2. Lancer une vidéo → contrôles sur mousemove uniquement, dropdowns desktop, pas de bottom sheet.
3. Hover sur une card → overlay play visible.

### Phone (Android natif < 768 px ou Chrome mobile)
1. Sidebar drawer (hamburger), bottom navbar visible.
2. Player → tap centre montre les contrôles, bottom sheets pour subtitles/audio/speed/settings.
3. 3 s sans tap pendant lecture → contrôles auto-hide; tap recentre.

### **Tablet Android (le bug actuel)**
1. Ouvrir l'app sans `?tv=1` → `body` n'a **pas** `.tv` (avant: oui). `body.tablet` posée.
2. Lancer la vidéo → tap centre montre les contrôles (avant: cassé). Bottom sheets fonctionnent. Boutons un cran plus gros que sur phone.
3. Sidebar: drawer fermable, hamburger visible.
4. Cards: pas d'overlay hover, long-press ouvre le panneau d'actions.
5. Forcer `?tv=1` dans l'URL → bascule en mode TV (focus rings, dropdowns desktop) — vérifie l'override.

### TV (émulateur Android TV ou device)
1. Boot → `body.tv` (UA `AndroidTV/1`).
2. D-pad navigue entre cards (in-line + cone), pas de double-saut (régression du commit récent — vérifier que le fix tient).
3. Ouvrir le player → contrôles dropdowns, focus visible. Seekbar owns ←→ (vérifier que spatial nav skip si `role="slider"`).
4. **Dropdown subtitles**: Enter sur le trigger → focus auto sur 1er item ; Down/Up navigue dans la liste ; Right/Left ne sortent pas du panneau ; Escape/Back ferme et refocus le trigger ; clic extérieur ferme.
5. Auto-hide à 5 s pendant lecture (avant: 3 s).

### Acceptance
- Aucune régression sur les 3 cibles existantes.
- Plus aucun rapport "contrôles bloqués sur tablette".

---

## 5. Hors-périmètre (à ne PAS faire dans ce plan)

- Refonte du player ou des bottom sheets (juste corriger le routing entre layouts).
- Suppression de `TvService` (gardé en façade tant que tous les consumers ne sont pas migrés).
- Détection iOS / iPadOS spécifique: pour l'instant `pointer: coarse + vw≥768` couvre l'iPad. Si bug remonté plus tard, ajouter UA `iPad`.
- Gamepad / contrôleur Bluetooth: hors scope, traiter en P2.
