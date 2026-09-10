import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';
import { serverConfigGuard } from './core/guards/server-config.guard';
import { passwordChangeGuard } from './core/guards/password-change.guard';
import { noTvGuard } from './core/guards/no-tv.guard';
import { desktopGuard } from './core/guards/desktop.guard';
import { pluginViewGuard } from './core/guards/plugin-view.guard';
import { ProfileContextService } from './features/profile/profile-context.service';

export const routes: Routes = [
  {
    path: 'setup',
    loadComponent: () =>
      import('./features/setup/setup').then((m) => m.SetupComponent),
  },
  {
    path: 'select-user',
    canActivate: [serverConfigGuard],
    loadComponent: () =>
      import('./features/select-user/select-user').then((m) => m.SelectUserComponent),
  },
  {
    path: 'login',
    canActivate: [serverConfigGuard],
    loadComponent: () =>
      import('./features/login/login').then((m) => m.LoginComponent),
  },
  {
    path: 'quick-connect/:userId',
    canActivate: [serverConfigGuard],
    loadComponent: () =>
      import('./features/quick-connect/quick-connect-wait').then((m) => m.QuickConnectWaitComponent),
  },
  {
    path: 'forced-password-change',
    // Auth required (we need a logged-in user) but no passwordChangeGuard —
    // this is the page the guard redirects TO.
    canActivate: [serverConfigGuard, authGuard],
    loadComponent: () =>
      import('./features/forced-password-change/forced-password-change').then(
        (m) => m.ForcedPasswordChangeComponent,
      ),
  },
  {
    path: 'watch/:mediaFileId',
    canActivate: [serverConfigGuard, authGuard, passwordChangeGuard],
    loadComponent: () =>
      import('./features/player/player').then((m) => m.PlayerComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/layout/layout').then((m) => m.LayoutComponent),
    canActivate: [serverConfigGuard, authGuard, passwordChangeGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./features/home/home').then((m) => m.HomeComponent),
        data: { titleKey: 'nav.home', reuse: true },
      },
      {
        path: 'libraries/:libraryName',
        loadComponent: () =>
          import('./features/library/library').then((m) => m.LibraryComponent),
        data: { reuse: true },
      },
      // The app's only way to reach "my movies/series" without knowing the library's
      // name: LibraryComponent resolves the sentinel to whichever library holds the flag.
      {
        path: 'movies',
        redirectTo: '/libraries/__default_movies__',
        pathMatch: 'full',
      },
      {
        path: 'series',
        redirectTo: '/libraries/__default_series__',
        pathMatch: 'full',
      },
      {
        path: 'downloads',
        canActivate: [noTvGuard],
        loadComponent: () =>
          import('./features/downloads/downloads').then((m) => m.DownloadsComponent),
        data: { titleKey: 'downloads.title' },
      },
      {
        path: 'persons',
        loadComponent: () =>
          import('./features/persons/persons').then((m) => m.PersonsComponent),
        data: { titleKey: 'persons.title', reuse: true },
      },
      {
        path: 'playlists',
        loadComponent: () =>
          import('./features/playlists/playlists').then(
            (m) => m.PlaylistsComponent,
          ),
        data: { titleKey: 'playlists.title', reuse: true },
      },
      {
        path: 'playlists/:id',
        loadComponent: () =>
          import('./features/playlists/playlist-detail/playlist-detail').then(
            (m) => m.PlaylistDetailComponent,
          ),
      },
      {
        path: 'profile/:userId',
        canActivate: [noTvGuard],
        providers: [ProfileContextService],
        loadComponent: () =>
          import('./features/profile/profile').then((m) => m.ProfileComponent),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/profile/profile-overview').then(
                (m) => m.ProfileOverviewComponent,
              ),
          },
          {
            path: 'followers',
            data: { mode: 'followers' },
            loadComponent: () =>
              import('./features/profile/profile-connections').then(
                (m) => m.ProfileConnectionsComponent,
              ),
          },
          {
            path: 'following',
            data: { mode: 'following' },
            loadComponent: () =>
              import('./features/profile/profile-connections').then(
                (m) => m.ProfileConnectionsComponent,
              ),
          },
          {
            path: 'statistics',
            loadComponent: () =>
              import('./features/profile/profile-statistics').then(
                (m) => m.ProfileStatisticsComponent,
              ),
          },
          {
            path: 'recommendations',
            loadComponent: () =>
              import('./features/profile/profile-recommendations').then(
                (m) => m.ProfileRecommendationsComponent,
              ),
          },
        ],
      },
      {
        path: 'persons/:id',
        loadComponent: () =>
          import('./features/person-detail/person-detail').then(
            (m) => m.PersonDetailComponent,
          ),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/person-detail/person-library').then(
                (m) => m.PersonLibraryComponent,
              ),
          },
          {
            path: 'filmography',
            loadComponent: () =>
              import('./features/person-detail/person-filmography').then(
                (m) => m.PersonFilmographyComponent,
              ),
          },
        ],
      },
      {
        path: 'search',
        loadComponent: () =>
          import('./features/search/search').then((m) => m.SearchComponent),
        data: { titleKey: 'search.title', reuse: true },
      },
      {
        path: 'add/movie/:provider/:externalId',
        loadComponent: () =>
          import('./features/tmdb-preview/tmdb-preview').then((m) => m.TmdbPreviewComponent),
      },
      {
        path: 'add/tv/:provider/:externalId',
        loadComponent: () =>
          import('./features/tmdb-preview/tmdb-preview').then((m) => m.TmdbPreviewComponent),
      },
      // Backward compat: /add/movie/:tmdbId → defaults to tmdb provider
      {
        path: 'add/movie/:tmdbId',
        loadComponent: () =>
          import('./features/tmdb-preview/tmdb-preview').then((m) => m.TmdbPreviewComponent),
      },
      {
        path: 'add/tv/:tmdbId',
        loadComponent: () =>
          import('./features/tmdb-preview/tmdb-preview').then((m) => m.TmdbPreviewComponent),
      },
      {
        path: 'movies/:id',
        loadComponent: () =>
          import('./features/media-detail/media-detail').then(
            (m) => m.MediaDetailComponent,
          ),
        data: { kind: 'movie', reuse: true },
      },
      {
        path: 'series/:id',
        loadComponent: () =>
          import('./features/media-detail/media-detail').then(
            (m) => m.MediaDetailComponent,
          ),
        data: { kind: 'series', reuse: true },
      },
      {
        path: 'series/:id/episode/:episodeId',
        loadComponent: () =>
          import('./features/media-detail/media-detail').then(
            (m) => m.MediaDetailComponent,
          ),
        // Switching episodes only moves a param on a page that already holds
        // the season rails, the subtitle list and the poster, and the component
        // reads the params itself, so it keeps its instance.
        data: { kind: 'series', reuse: true, reuseOnParamChange: true },
      },
      {
        path: 'requests',
        loadComponent: () =>
          import('./features/requests/requests').then((m) => m.RequestsComponent),
        data: { titleKey: 'requests.title' },
      },
      {
        path: 'calendar',
        loadComponent: () =>
          import('./features/calendar/calendar').then((m) => m.CalendarComponent),
        data: { titleKey: 'calendar.title' },
      },
      {
        path: 'history',
        loadComponent: () =>
          import('./features/watch-history/watch-history').then(
            (m) => m.WatchHistoryComponent,
          ),
        data: { titleKey: 'history.title', reuse: true },
      },
      {
        path: 'pending-requests',
        loadComponent: () =>
          import('./features/pending-requests/pending-requests').then(
            (m) => m.PendingRequestsComponent,
          ),
        data: { titleKey: 'pending_requests.title' },
      },
      {
        path: 'plugins/:pluginId/:view',
        canActivate: [pluginViewGuard],
        loadComponent: () =>
          import('./features/plugin-view/plugin-view').then((m) => m.PluginViewComponent),
      },
    ],
  },
  // Account settings — own layout with sidebar
  {
    path: 'account',
    loadComponent: () =>
      import('./features/account/account-shell').then((m) => m.AccountShellComponent),
    canActivate: [serverConfigGuard, authGuard, passwordChangeGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'password' },
      {
        path: 'password',
        loadComponent: () =>
          import('./features/account/account').then((m) => m.AccountComponent),
      },
      {
        path: 'recommendations',
        loadComponent: () =>
          import('./features/account/recommendations').then(
            (m) => m.AccountRecommendationsComponent,
          ),
      },
      {
        path: 'privacy',
        loadComponent: () =>
          import('./features/account/privacy').then(
            (m) => m.AccountPrivacyComponent,
          ),
      },
      {
        path: 'spoilers',
        loadComponent: () =>
          import('./features/account/spoilers').then(
            (m) => m.AccountSpoilersComponent,
          ),
      },
    ],
  },
  // App settings — own layout with sidebar
  {
    path: 'app-settings',
    loadComponent: () =>
      import('./features/app-settings/app-settings-shell').then((m) => m.AppSettingsShellComponent),
    canActivate: [serverConfigGuard, authGuard, passwordChangeGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'home' },
      {
        path: 'home',
        loadComponent: () =>
          import('./features/app-settings/home-settings/home-settings').then(
            (m) => m.HomeSettingsPageComponent,
          ),
      },
      {
        path: 'player',
        loadComponent: () =>
          import('./features/playback-settings/player-settings/player-settings').then(
            (m) => m.PlayerSettingsPageComponent,
          ),
      },
      {
        path: 'subtitles',
        loadComponent: () =>
          import('./features/playback-settings/subtitle-settings/subtitle-settings').then(
            (m) => m.SubtitleSettingsPageComponent,
          ),
      },
      {
        path: 'cast',
        canActivate: [noTvGuard],
        loadComponent: () =>
          import('./features/playback-settings/cast-settings/cast-settings').then(
            (m) => m.CastSettingsPageComponent,
          ),
      },
      {
        path: 'remote',
        loadComponent: () =>
          import('./features/app-settings/remote-settings/remote-settings').then(
            (m) => m.RemoteSettingsPageComponent,
          ),
      },
      {
        path: 'storage',
        canActivate: [noTvGuard],
        loadComponent: () =>
          import('./features/playback-settings/storage-settings/storage-settings').then(
            (m) => m.StorageSettingsPageComponent,
          ),
      },
      {
        path: 'display',
        loadComponent: () =>
          import('./features/app-settings/display-settings/display-settings').then(
            (m) => m.DisplaySettingsPageComponent,
          ),
      },
      {
        path: 'update',
        canActivate: [desktopGuard],
        loadComponent: () =>
          import('./features/app-settings/update-settings/update-settings').then(
            (m) => m.UpdateSettingsPageComponent,
          ),
      },
    ],
  },
  // Admin area — own layout with dedicated sidebar
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/admin-shell').then((m) => m.AdminShellComponent),
    canActivate: [serverConfigGuard, authGuard, passwordChangeGuard, adminGuard, noTvGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'statistics' },
      { path: 'statistics', loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.DashboardComponent) },
      {
        path: 'users/:id',
        loadComponent: () => import('./features/settings/users/user-detail/user-detail').then((m) => m.UserDetailComponent),
        children: [
          { path: '', loadComponent: () => import('./features/settings/users/user-detail/user-general').then((m) => m.UserGeneralComponent) },
          { path: 'requests', loadComponent: () => import('./features/settings/users/user-detail/user-requests').then((m) => m.UserRequestsComponent) },
          { path: 'stats', loadComponent: () => import('./features/settings/users/user-detail/user-stats').then((m) => m.UserStatsComponent) },
        ],
      },
      {
        path: 'system',
        loadComponent: () => import('./features/system/system').then((m) => m.SystemComponent),
        children: [
          { path: '', loadComponent: () => import('./features/system/status/status').then((m) => m.SystemStatusComponent) },
          { path: 'backups', loadComponent: () => import('./features/system/backups/backups').then((m) => m.SystemBackupsComponent) },
          { path: 'logs', loadComponent: () => import('./features/system/logs/logs').then((m) => m.SystemLogsComponent) },
        ],
      },
      { path: 'streams', loadComponent: () => import('./features/system/streams/streams').then((m) => m.SystemStreamsComponent) },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings-shell').then((m) => m.SettingsShellComponent),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'general' },
          { path: 'general', loadComponent: () => import('./features/settings/general/general').then((m) => m.GeneralSettingsComponent) },
          { path: 'quality-profiles', loadComponent: () => import('./features/settings/quality-profiles/quality-profiles').then((m) => m.QualityProfilesComponent) },
          { path: 'language-profiles', loadComponent: () => import('./features/settings/language-profiles/language-profiles').then((m) => m.LanguageProfilesComponent) },
          { path: 'quality-definitions', loadComponent: () => import('./features/settings/quality-definitions/quality-definitions').then((m) => m.QualityDefinitionsComponent) },
          { path: 'custom-formats', loadComponent: () => import('./features/settings/custom-formats/custom-formats').then((m) => m.CustomFormatsSettingsComponent) },
          { path: 'naming', loadComponent: () => import('./features/settings/naming/naming').then((m) => m.NamingSettingsComponent) },
          { path: 'notifications', loadComponent: () => import('./features/settings/notifications/notifications').then((m) => m.NotificationsSettingsComponent) },
          { path: 'media-servers', loadComponent: () => import('./features/settings/media-servers/media-servers').then((m) => m.MediaServersSettingsComponent) },
          { path: 'plugins', loadComponent: () => import('./features/settings/plugins/plugins').then((m) => m.PluginsSettingsComponent) },
          { path: 'plugin-catalogue', loadComponent: () => import('./features/settings/plugins/plugin-catalogue/plugin-catalogue-page').then((m) => m.PluginCataloguePageComponent) },
          {
            path: 'plugins/:pluginId/:view',
            canActivate: [pluginViewGuard],
            loadComponent: () => import('./features/plugin-view/plugin-view').then((m) => m.PluginViewComponent),
          },
          { path: 'data-imports', loadComponent: () => import('./features/settings/data-imports/data-imports').then((m) => m.DataImportsSettingsComponent) },
          { path: 'libraries', loadComponent: () => import('./features/settings/libraries/libraries').then((m) => m.LibrariesSettingsComponent) },
          { path: 'libraries/new', loadComponent: () => import('./features/settings/libraries/library-wizard/library-wizard').then((m) => m.LibraryWizardComponent) },
          {
            path: 'libraries/:id',
            loadComponent: () => import('./features/settings/libraries/library-detail/library-detail').then((m) => m.LibraryDetailComponent),
            children: [
              { path: '', pathMatch: 'full', redirectTo: 'general' },
              { path: 'general', loadComponent: () => import('./features/settings/libraries/library-detail/library-general').then((m) => m.LibraryGeneralComponent) },
              { path: 'media', loadComponent: () => import('./features/settings/libraries/library-detail/library-media').then((m) => m.LibraryMediaComponent) },
              { path: 'users', loadComponent: () => import('./features/settings/libraries/library-detail/library-users').then((m) => m.LibraryUsersComponent) },
            ],
          },
          { path: 'users', loadComponent: () => import('./features/settings/users/users').then((m) => m.UsersSettingsComponent) },
          { path: 'roles', loadComponent: () => import('./features/settings/roles/roles').then((m) => m.RolesSettingsComponent) },
          { path: 'subtitle-providers', loadComponent: () => import('./features/settings/subtitle-providers/subtitle-providers').then((m) => m.SubtitleProvidersSettingsComponent) },
          { path: 'subtitles-activity', loadComponent: () => import('./features/settings/subtitles-activity/subtitles-activity').then((m) => m.SubtitlesActivityComponent) },
          {
            path: 'subtitles',
            loadComponent: () => import('./features/settings/subtitles/subtitles-shell').then((m) => m.SubtitlesShellComponent),
            children: [
              { path: '', loadComponent: () => import('./features/settings/subtitles/subtitles-settings').then((m) => m.SubtitlesSettingsComponent) },
              { path: 'stats', loadComponent: () => import('./features/settings/subtitles/subtitles-stats').then((m) => m.SubtitlesStatsComponent) },
            ],
          },
          { path: 'schedulers', loadComponent: () => import('./features/settings/schedulers/schedulers').then((m) => m.SchedulersComponent) },
          { path: 'auto-approval', loadComponent: () => import('./features/settings/auto-approval/auto-approval').then((m) => m.AutoApprovalSettingsComponent) },
          { path: 'streaming', loadComponent: () => import('./features/settings/streaming/streaming').then((m) => m.StreamingSettingsComponent) },
        ],
      },
    ],
  },
];
