import { ApplicationInitStatus, provideAppInitializer } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { loadPersistedState } from './app.config';

/** The app initializer gates bootstrap: if it throws or never settles, the
 *  native builds stay on their splash screen forever. */
describe('loadPersistedState', () => {
  it('resolves inside an injection context', async () => {
    TestBed.configureTestingModule({
      providers: [provideAppInitializer(loadPersistedState)],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    expect(TestBed.inject(ApplicationInitStatus).done).toBe(true);
  });
});
