import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-collection-detail',
  templateUrl: './collection-detail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionDetailComponent {}
