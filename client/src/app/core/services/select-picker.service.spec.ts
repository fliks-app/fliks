import { TestBed } from '@angular/core/testing';
import { SelectPickerService } from './select-picker.service';

function mount(html: string): HTMLSelectElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector('select')!;
}

describe('SelectPickerService title', () => {
  let picker: SelectPickerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    picker = TestBed.inject(SelectPickerService);
  });

  afterEach(() => document.body.replaceChildren());

  it('takes the daisyUI label text, not the hint below it', () => {
    picker.show(
      mount(`<label class="form-control">
               <div class="label"><span class="label-text">Subtitle mode</span></div>
               <select><option>a</option></select>
               <div class="label"><span class="label-text-alt">Hint</span></div>
             </label>`),
    );
    expect(picker.title()).toBe('Subtitle mode');
  });

  it('drops a trailing colon from the label', () => {
    picker.show(
      mount(`<label class="form-control">
               <div class="label"><span class="label-text">Trier par\u00a0:</span></div>
               <select></select>
             </label>`),
    );
    expect(picker.title()).toBe('Trier par');
  });

  it('falls back to a for-associated label and to aria-label', () => {
    picker.show(mount(`<label for="s">Sort by</label><select id="s"></select>`));
    expect(picker.title()).toBe('Sort by');

    picker.show(mount(`<select aria-label="Status"></select>`));
    expect(picker.title()).toBe('Status');
  });

  it('prefers an explicit title and stays empty with no label at all', () => {
    const select = mount(`<label class="form-control">
                            <div class="label"><span class="label-text">Ignored</span></div>
                            <select></select>
                          </label>`);
    picker.show(select, 'Explicit');
    expect(picker.title()).toBe('Explicit');

    picker.show(mount(`<select></select>`));
    expect(picker.title()).toBe('');
  });
});
