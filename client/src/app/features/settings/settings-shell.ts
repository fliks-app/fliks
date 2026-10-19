import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Thin wrapper; navigation is the sidebar dropdown in LayoutComponent. */
@Component({
  selector: 'app-settings-shell',
  imports: [RouterOutlet],
  templateUrl: './settings-shell.html',
})
export class SettingsShellComponent {}
