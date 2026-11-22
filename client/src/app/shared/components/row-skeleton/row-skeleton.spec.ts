import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RowSkeletonComponent } from './row-skeleton';

describe('RowSkeletonComponent', () => {
  it('renders the asked number of placeholders', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(RowSkeletonComponent);
    fixture.componentRef.setInput('rows', 3);
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.bg-base-300\\/40')).toHaveLength(3);
  });
});
