import type { UiContribution } from '@fliks/plugin-contract/ui';
import { evaluateWhen, type WhenContext } from './when-evaluator';

/** One contribution that survived gating, with its action already resolved. */
export interface ResolvedMenuRow {
  id: string;
  weight: number;
  labelKey: string;
  icon: string;
  tone: 'default' | 'danger';
  confirmKey?: string;
  actionId?: string;
  route?: string;
  run: (() => void) | null;
  /** Present on a submenu row. A submenu whose children all dropped is dropped
   *  too — an empty group is worse than no group. */
  children?: ResolvedMenuRow[];
}

/**
 * Turns a set of `UiContribution`s into the rows a menu can render.
 *
 * One routine for every surface that shows media actions: the card panel and
 * the detail header used to keep a copy each, which is how their two lists
 * drifted apart in the first place. A row is dropped — never rendered broken —
 * when its `when` fails, when a core alias's own gate fails, when a caller
 * guard says no, or when no handler resolves its actionId. That last one is
 * what lets a surface publish only the actions it can actually perform: the
 * rest fall away instead of being listed and doing nothing.
 */
export function resolveMenuContributions(opts: {
  contributions: readonly UiContribution[];
  ctx: WhenContext;
  /** Visibility the closed `when` vocabulary can't express, by contribution id. */
  guards?: Record<string, () => boolean>;
  /** Resolves an actionId to a handler, or null when this surface can't serve it. */
  resolveAction: (actionId: string) => (() => void) | null;
  /** Navigates for a `route` contribution. */
  navigate: (path: string) => void;
}): ResolvedMenuRow[] {
  const { contributions, ctx, guards = {}, resolveAction, navigate } = opts;

  const ordered = [...contributions].sort(
    (a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  /** Every contribution at any depth. A core row moved into a submenu must still
   *  be found by the alias check below, or a plugin could widen it by aliasing
   *  an actionId whose gate the search no longer reaches. */
  const flatten = (list: readonly UiContribution[]): UiContribution[] =>
    list.flatMap((c) => [c, ...flatten(c.children ?? [])]);
  const everything = flatten(contributions);

  /** A contribution aliasing a core actionId inherits that core row's gate: a
   *  plugin may narrow one of core's actions, never widen it. */
  const coreFor = (c: UiContribution) => {
    if (c.action.kind !== 'action') return undefined;
    const wanted = c.action.actionId;
    return everything.find(
      (a) => a.id.startsWith('core.') && a.action.kind === 'action' && a.action.actionId === wanted,
    );
  };

  const rows: ResolvedMenuRow[] = [];
  const seen = new Set<string>();

  for (const c of ordered) {
    if (seen.has(c.id)) continue;
    if (!evaluateWhen(c.when, ctx)) continue;

    const core = coreFor(c);
    if (core && core.id !== c.id) {
      if (!evaluateWhen(core.when, ctx)) continue;
      if (!(guards[core.id]?.() ?? true)) continue;
    }
    if (!(guards[c.id]?.() ?? true)) continue;

    const base = {
      id: c.id,
      weight: c.weight,
      labelKey: c.labelKey,
      icon: c.icon ?? 'circle',
      tone: c.tone ?? ('default' as const),
      confirmKey: c.confirmKey,
    };

    if (c.action.kind === 'submenu') {
      const children = resolveMenuContributions({ ...opts, contributions: c.children ?? [] });
      if (!children.length) continue;
      rows.push({ ...base, run: null, children });
    } else if (c.action.kind === 'route') {
      const path = c.action.path;
      rows.push({ ...base, route: path, run: () => navigate(path) });
    } else if (c.action.kind === 'action') {
      const run = resolveAction(c.action.actionId);
      if (!run) continue;
      rows.push({ ...base, actionId: c.action.actionId, run });
    } else {
      continue; // unrecognised action kind
    }
    seen.add(c.id);
  }

  return rows;
}
