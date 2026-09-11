import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CaslAbilityFactory, type AppAbility } from '../auth/casl/casl-ability.factory';
import { checkDeclaredPolicy } from './proxy/policy-vocabulary';
import { PluginRegistryService, type RegisteredPlugin } from './plugin-registry.service';
import type { User } from '../users/entities/user.entity';
import type { ConfigPage, ReleasePickerRoutes, UiContribution } from '../../common/plugin-contract';

export interface PluginUiEntry {
  pluginId: string;
  /** The manifest's human-readable name — labels the plugin's own settings section. */
  name: string;
  contributions: UiContribution[];
  configPages: ConfigPage[];
  /** Flat `"a.b.c"` dicts per locale; the client merges them under core's own keys. */
  i18n: Record<string, Record<string, string>>;
  /** At most one plugin across the whole listing ever carries this. */
  releasePicker?: ReleasePickerRoutes;
}

/** Both paths core mounts a plugin's `<pageId>` view under: the sidebar one and the admin one. */
function viewPathsFor(pluginId: string, pageId: string): string[] {
  return [`/plugins/${pluginId}/${pageId}`, `/admin/settings/plugins/${pluginId}/${pageId}`];
}

/** Every key (any locale) a plugin's manifest declares, flattened into one set. */
function i18nKeysOf(plugin: RegisteredPlugin): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const dict of Object.values(plugin.manifest.i18n ?? {})) {
    for (const key of Object.keys(dict)) keys.add(key);
  }
  return keys;
}

/** True when neither key can sit in the same flat tree without one clobbering the other. */
function branchesConflict(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/** The already-accepted plugin (if any) whose keys conflict with one of `keys`, and which key. */
function findCollision(
  keys: ReadonlySet<string>,
  accepted: readonly { pluginId: string; keys: ReadonlySet<string> }[],
): { withPluginId: string; key: string } | undefined {
  for (const entry of accepted) {
    for (const existingKey of entry.keys) {
      for (const key of keys) {
        if (branchesConflict(key, existingKey)) return { withPluginId: entry.pluginId, key };
      }
    }
  }
  return undefined;
}

/**
 * Drops any plugin whose i18n keys collide with (equal, or dotted-ancestor of) an
 * already-accepted plugin's — official signatures are accepted first, ties break by
 * id — so two plugins' dicts can never corrupt each other once merged in the browser.
 */
function withoutI18nCollisions(plugins: readonly RegisteredPlugin[], logger: Logger): RegisteredPlugin[] {
  const ordered = [...plugins].sort(
    (a, b) =>
      Number(b.signature === 'official') - Number(a.signature === 'official') ||
      (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0),
  );
  const accepted: { pluginId: string; keys: ReadonlySet<string> }[] = [];
  const keptIds = new Set<string>();
  for (const plugin of ordered) {
    const keys = i18nKeysOf(plugin);
    const collision = findCollision(keys, accepted);
    if (collision) {
      logger.warn(
        `plugin "${plugin.pluginId}" refused from /plugins/ui: i18n key "${collision.key}" collides with "${collision.withPluginId}"`,
      );
      continue;
    }
    accepted.push({ pluginId: plugin.pluginId, keys });
    keptIds.add(plugin.pluginId);
  }
  return plugins.filter((p) => keptIds.has(p.pluginId));
}

/**
 * Feeds the app-initializer chain that gates the splash screen, so every logged-in user needs it:
 * open to any session, but its payload is cut to what the caller's own ability allows. Reads the
 * in-memory manifest cache `PluginRegistryService` already keeps (never a live call to a plugin):
 * a dead plugin's socket timeout must never hold up app boot.
 */
@Controller('plugins')
@UseGuards(JwtOrApiKeyGuard)
export class PluginUiController {
  private readonly logger = new Logger(PluginUiController.name);

  constructor(
    private readonly registry: PluginRegistryService,
    private readonly abilityFactory: CaslAbilityFactory,
  ) {}

  @Get('ui')
  list(@CurrentUser() user: User): PluginUiEntry[] {
    const ability = this.abilityFactory.createForUser(user);
    const active = this.registry
      .list()
      .filter((plugin) => plugin.kind === 'data' || this.registry.processStateOf(plugin.pluginId) === 'ready');
    return withoutI18nCollisions(active, this.logger).map((plugin) => {
      const { contributions, configPages } = this.visibleTo(plugin, ability);
      return {
        pluginId: plugin.pluginId,
        name: plugin.manifest.name,
        contributions,
        configPages,
        i18n: plugin.manifest.i18n ?? {},
        releasePicker: this.registry.releasePickerFor(plugin.pluginId),
      };
    });
  }

  /** Drops the pages this viewer may not read and the contributions opening them. A manifest's
   *  own `when` cannot make this join: only core knows the policy behind a page's route. */
  private visibleTo(plugin: RegisteredPlugin, ability: AppAbility): { contributions: UiContribution[]; configPages: ConfigPage[] } {
    const pages = plugin.manifest.ui?.configPages ?? [];
    const contributions = plugin.manifest.ui?.contributions ?? [];
    const subjects = this.registry.declaredPermissionsFor(plugin.pluginId);
    const hiddenPaths = new Set<string>();
    const visiblePages = pages.filter((page) => {
      if (this.mayReadPage(plugin.pluginId, page, ability, subjects)) return true;
      for (const path of viewPathsFor(plugin.pluginId, page.id)) hiddenPaths.add(path);
      return false;
    });
    return {
      configPages: visiblePages,
      contributions: contributions.filter((c) => c.action.kind !== 'route' || !hiddenPaths.has(c.action.path)),
    };
  }

  /** A `form` page reads no plugin route and rides the admin gate. Every other kind needs the
   *  policy of the route it lists from, and an unresolvable route hides the page. */
  private mayReadPage(pluginId: string, page: ConfigPage, ability: AppAbility, subjects: ReadonlySet<string>): boolean {
    if (page.kind !== 'table' && page.kind !== 'providers') return true;
    const resolved = this.registry.resolveRoute(pluginId, 'GET', page.list);
    return !!resolved && checkDeclaredPolicy(resolved.route.policy, ability, subjects);
  }
}
