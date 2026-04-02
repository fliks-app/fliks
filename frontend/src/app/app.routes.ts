import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login').then((m) => m.LoginComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/layout/layout').then((m) => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((m) => m.DashboardComponent),
      },
      {
        path: 'movies',
        loadComponent: () =>
          import('./features/movies/movies').then((m) => m.MoviesComponent),
      },
      {
        path: 'series',
        loadComponent: () =>
          import('./features/series/series').then((m) => m.SeriesComponent),
      },
      {
        path: 'add',
        loadComponent: () =>
          import('./features/discover/discover').then((m) => m.DiscoverComponent),
      },
      {
        path: 'add/movie/:tmdbId',
        loadComponent: () =>
          import('./features/discover/tmdb-preview').then((m) => m.TmdbPreviewComponent),
      },
      {
        path: 'add/tv/:tmdbId',
        loadComponent: () =>
          import('./features/discover/tmdb-preview').then((m) => m.TmdbPreviewComponent),
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
          import('./features/episode-detail/episode-detail').then(
            (m) => m.EpisodeDetailComponent,
          ),
      },
      {
        path: 'requests',
        loadComponent: () =>
          import('./features/requests/requests').then((m) => m.RequestsComponent),
      },
      {
        path: 'activity',
        loadComponent: () =>
          import('./features/activity/activity').then((m) => m.ActivityComponent),
      },
      {
        path: 'calendar',
        loadComponent: () =>
          import('./features/calendar/calendar').then((m) => m.CalendarComponent),
      },
      {
        path: 'import-disk',
        loadComponent: () =>
          import('./features/import-disk/import-disk').then((m) => m.ImportDiskComponent),
        canActivate: [adminGuard],
      },
      {
        path: 'import',
        loadComponent: () =>
          import('./features/import/import').then((m) => m.ImportComponent),
        canActivate: [adminGuard],
      },
      {
        path: 'system',
        loadComponent: () =>
          import('./features/system/system').then((m) => m.SystemComponent),
        canActivate: [adminGuard],
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/settings-shell').then(
            (m) => m.SettingsShellComponent,
          ),
        canActivate: [adminGuard],
        children: [
          {
            path: '',
            pathMatch: 'full',
            redirectTo: 'general',
          },
          {
            path: 'general',
            loadComponent: () =>
              import('./features/settings/general/general').then(
                (m) => m.GeneralSettingsComponent,
              ),
          },
          {
            path: 'quality-profiles',
            loadComponent: () =>
              import(
                './features/settings/quality-profiles/quality-profiles'
              ).then((m) => m.QualityProfilesComponent),
          },
          {
            path: 'language-profiles',
            loadComponent: () =>
              import(
                './features/settings/language-profiles/language-profiles'
              ).then((m) => m.LanguageProfilesComponent),
          },
          {
            path: 'quality-definitions',
            loadComponent: () =>
              import(
                './features/settings/quality-definitions/quality-definitions'
              ).then((m) => m.QualityDefinitionsComponent),
          },
          {
            path: 'custom-formats',
            loadComponent: () =>
              import(
                './features/settings/custom-formats/custom-formats'
              ).then((m) => m.CustomFormatsSettingsComponent),
          },
          {
            path: 'indexers',
            loadComponent: () =>
              import('./features/settings/indexers/indexers').then(
                (m) => m.IndexersSettingsComponent,
              ),
          },
          {
            path: 'download-clients',
            loadComponent: () =>
              import(
                './features/settings/download-clients/download-clients'
              ).then((m) => m.DownloadClientsSettingsComponent),
          },
          {
            path: 'naming',
            loadComponent: () =>
              import('./features/settings/naming/naming').then(
                (m) => m.NamingSettingsComponent,
              ),
          },
          {
            path: 'blocklist',
            loadComponent: () =>
              import('./features/settings/blocklist/blocklist').then(
                (m) => m.BlocklistSettingsComponent,
              ),
          },
          {
            path: 'notifications',
            loadComponent: () =>
              import(
                './features/settings/notifications/notifications'
              ).then((m) => m.NotificationsSettingsComponent),
          },
          {
            path: 'media-servers',
            loadComponent: () =>
              import(
                './features/settings/media-servers/media-servers'
              ).then((m) => m.MediaServersSettingsComponent),
          },
          {
            path: 'root-folders',
            loadComponent: () =>
              import(
                './features/settings/root-folders/root-folders'
              ).then((m) => m.RootFoldersSettingsComponent),
          },
          {
            path: 'tags',
            loadComponent: () =>
              import('./features/settings/tags/tags').then(
                (m) => m.TagsSettingsComponent,
              ),
          },
          {
            path: 'users',
            loadComponent: () =>
              import('./features/settings/users/users').then(
                (m) => m.UsersSettingsComponent,
              ),
          },
          {
            path: 'users/:id',
            loadComponent: () =>
              import(
                './features/settings/users/user-detail/user-detail'
              ).then((m) => m.UserDetailComponent),
            children: [
              {
                path: '',
                loadComponent: () =>
                  import(
                    './features/settings/users/user-detail/user-general'
                  ).then((m) => m.UserGeneralComponent),
              },
              {
                path: 'requests',
                loadComponent: () =>
                  import(
                    './features/settings/users/user-detail/user-requests'
                  ).then((m) => m.UserRequestsComponent),
              },
            ],
          },
          {
            path: 'roles',
            loadComponent: () =>
              import('./features/settings/roles/roles').then(
                (m) => m.RolesSettingsComponent,
              ),
          },
          {
            path: 'remote-path-mappings',
            loadComponent: () =>
              import(
                './features/settings/remote-path-mappings/remote-path-mappings'
              ).then((m) => m.RemotePathMappingsSettingsComponent),
          },
          {
            path: 'subtitle-providers',
            loadComponent: () =>
              import(
                './features/settings/subtitle-providers/subtitle-providers'
              ).then((m) => m.SubtitleProvidersSettingsComponent),
          },
          {
            path: 'subtitles',
            loadComponent: () =>
              import(
                './features/settings/subtitles/subtitles-settings'
              ).then((m) => m.SubtitlesSettingsComponent),
          },
          {
            path: 'delay-profiles',
            loadComponent: () =>
              import(
                './features/settings/delay-profiles/delay-profiles'
              ).then((m) => m.DelayProfilesComponent),
          },
          {
            path: 'auto-approval',
            loadComponent: () =>
              import(
                './features/settings/auto-approval/auto-approval'
              ).then((m) => m.AutoApprovalSettingsComponent),
          },
        ],
      },
    ],
  },
];
