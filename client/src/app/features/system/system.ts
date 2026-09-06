import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-system',
  imports: [TranslatePipe, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './system.html',
})
export class SystemComponent {}
