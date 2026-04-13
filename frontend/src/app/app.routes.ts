import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';
import { serverConfigGuard } from './core/guards/server-config.guard';

export const routes: Routes = [
  {
    path: 'setup',
    loadComponent: () =>
      import('./features/setup/setup').then((m) => m.SetupComponent),
  },
  {
    path: 'login',
    canActivate: [serverConfigGuard],
    loadComponent: () =>
      import('./features/login/login').then((m) => m.LoginComponent),
  },
  {
    path: 'watch/:mediaFileId',
    canActivate: [serverConfigGuard, authGuard],
    loadComponent: () =>
      import('./features/player/player').then((m) => m.PlayerComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/layout/layout').then((m) => m.LayoutComponent),
    canActivate: [serverConfigGuard, authGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./features/home/home').then((m) => m.HomeComponent),
        data: { titleKey: 'nav.home' },
      },
      {
        path: 'movies',
        loadComponent: () =>
          import('./features/movies/movies').then((m) => m.MoviesComponent),
        data: { titleKey: 'movies.title' },
      },
      {
        path: 'series',
        loadComponent: () =>
          import('./features/series/series').then((m) => m.SeriesComponent),
        data: { titleKey: 'series.title' },
      },
      {
        path: 'downloads',
        loadComponent: () =>
          import('./features/downloads/downloads').then((m) => m.DownloadsComponent),
        data: { titleKey: 'downloads.title' },
      },
      {
        path: 'persons',
        loadComponent: () =>
          import('./features/persons/persons').then((m) => m.PersonsComponent),
        data: { titleKey: 'persons.title' },
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
        data: { titleKey: 'search.title' },
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
        data: { kind: 'movie' },
      },
      {
        path: 'series/:id',
        loadComponent: () =>
          import('./features/media-detail/media-detail').then(
            (m) => m.MediaDetailComponent,
          ),
        data: { kind: 'series' },
      },
      {
        path: 'series/:id/episode/:episodeId',
        loadComponent: () =>
          import('./features/media-detail/media-detail').then(
            (m) => m.MediaDetailComponent,
          ),
        data: { kind: 'series' },
      },
      {
        path: 'requests',
        loadComponent: () =>
          import('./features/requests/requests').then((m) => m.RequestsComponent),
        data: { titleKey: 'requests.title' },
      },
      {
        path: 'activity',
        loadComponent: () =>
          import('./features/activity/activity').then((m) => m.ActivityComponent),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./features/activity/queue/queue').then(
                (m) => m.ActivityQueueComponent,
              ),
            data: { titleKey: 'activity.title' },
          },
          {
            path: 'subtitles',
            loadComponent: () =>
              import('./features/activity/subtitles/subtitles').then(
                (m) => m.ActivitySubtitlesComponent,
              ),
            data: { titleKey: 'activity.tab_subtitles' },
          },
        ],
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
        data: { titleKey: 'history.title' },
      },
    ],
  },
  // Account settings — own layout with sidebar
  {
    path: 'account',
    loadComponent: () =>
      import('./features/account/account-shell').then((m) => m.AccountShellComponent),
    canActivate: [serverConfigGuard, authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'password' },
      {
        path: 'password',
        loadComponent: () =>
          import('./features/account/account').then((m) => m.AccountComponent),
      },
    ],
  },
  // App settings — own layout with sidebar
  {
    path: 'app-settings',
    loadComponent: () =>
      import('./features/app-settings/app-settings-shell').then((m) => m.AppSettingsShellComponent),
    canActivate: [serverConfigGuard, authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'player' },
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
        loadComponent: () =>
          import('./features/playback-settings/cast-settings/cast-settings').then(
            (m) => m.CastSettingsPageComponent,
          ),
      },
    ],
  },
  // Admin area — own layout with dedicated sidebar
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/admin-shell').then((m) => m.AdminShellComponent),
    canActivate: [serverConfigGuard, authGuard, adminGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'statistics' },
      { path: 'statistics', loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.DashboardComponent) },
      { path: 'import-disk', loadComponent: () => import('./features/import-disk/import-disk').then((m) => m.ImportDiskComponent) },
      { path: 'import', loadComponent: () => import('./features/import/import').then((m) => m.ImportComponent) },
      {
        path: 'system',
        loadComponent: () => import('./features/system/system').then((m) => m.SystemComponent),
        children: [
          { path: '', loadComponent: () => import('./features/system/status/status').then((m) => m.SystemStatusComponent) },
          { path: 'backups', loadComponent: () => import('./features/system/backups/backups').then((m) => m.SystemBackupsComponent) },
          { path: 'logs', loadComponent: () => import('./features/system/logs/logs').then((m) => m.SystemLogsComponent) },
          { path: 'import', loadComponent: () => import('./features/system/import/import').then((m) => m.SystemImportComponent) },
          { path: 'streams', loadComponent: () => import('./features/system/streams/streams').then((m) => m.SystemStreamsComponent) },
        ],
      },
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
          { path: 'indexers', loadComponent: () => import('./features/settings/indexers/indexers').then((m) => m.IndexersSettingsComponent) },
          { path: 'download-clients', loadComponent: () => import('./features/settings/download-clients/download-clients').then((m) => m.DownloadClientsSettingsComponent) },
          { path: 'naming', loadComponent: () => import('./features/settings/naming/naming').then((m) => m.NamingSettingsComponent) },
          { path: 'blocklist', loadComponent: () => import('./features/settings/blocklist/blocklist').then((m) => m.BlocklistSettingsComponent) },
          { path: 'notifications', loadComponent: () => import('./features/settings/notifications/notifications').then((m) => m.NotificationsSettingsComponent) },
          { path: 'media-servers', loadComponent: () => import('./features/settings/media-servers/media-servers').then((m) => m.MediaServersSettingsComponent) },
          { path: 'libraries', loadComponent: () => import('./features/settings/libraries/libraries').then((m) => m.LibrariesSettingsComponent) },
          { path: 'tags', loadComponent: () => import('./features/settings/tags/tags').then((m) => m.TagsSettingsComponent) },
          { path: 'users', loadComponent: () => import('./features/settings/users/users').then((m) => m.UsersSettingsComponent) },
          {
            path: 'users/:id',
            loadComponent: () => import('./features/settings/users/user-detail/user-detail').then((m) => m.UserDetailComponent),
            children: [
              { path: '', loadComponent: () => import('./features/settings/users/user-detail/user-general').then((m) => m.UserGeneralComponent) },
              { path: 'requests', loadComponent: () => import('./features/settings/users/user-detail/user-requests').then((m) => m.UserRequestsComponent) },
            ],
          },
          { path: 'roles', loadComponent: () => import('./features/settings/roles/roles').then((m) => m.RolesSettingsComponent) },
          { path: 'subtitle-providers', loadComponent: () => import('./features/settings/subtitle-providers/subtitle-providers').then((m) => m.SubtitleProvidersSettingsComponent) },
          {
            path: 'subtitles',
            loadComponent: () => import('./features/settings/subtitles/subtitles-shell').then((m) => m.SubtitlesShellComponent),
            children: [
              { path: '', loadComponent: () => import('./features/settings/subtitles/subtitles-settings').then((m) => m.SubtitlesSettingsComponent) },
              { path: 'stats', loadComponent: () => import('./features/settings/subtitles/subtitles-stats').then((m) => m.SubtitlesStatsComponent) },
            ],
          },
          { path: 'delay-profiles', loadComponent: () => import('./features/settings/delay-profiles/delay-profiles').then((m) => m.DelayProfilesComponent) },
          { path: 'cleanup-profiles', loadComponent: () => import('./features/settings/cleanup-profiles/cleanup-profiles').then((m) => m.CleanupProfilesComponent) },
          { path: 'schedulers', loadComponent: () => import('./features/settings/schedulers/schedulers').then((m) => m.SchedulersComponent) },
          { path: 'auto-approval', loadComponent: () => import('./features/settings/auto-approval/auto-approval').then((m) => m.AutoApprovalSettingsComponent) },
          { path: 'network', loadComponent: () => import('./features/settings/network/network').then((m) => m.NetworkSettingsComponent) },
          { path: 'streaming', loadComponent: () => import('./features/settings/streaming/streaming').then((m) => m.StreamingSettingsComponent) },
        ],
      },
    ],
  },
];
