import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SchemaFormComponent } from './schema-form';
import type { FieldDef } from '../../../core/plugin-ui/contribution.types';

function createComponent(fields: FieldDef[], value: Record<string, unknown>) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const fixture = TestBed.createComponent(SchemaFormComponent);
  fixture.componentRef.setInput('fields', fields);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return fixture;
}

function setInputAndDispatch(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input'));
}

describe('SchemaFormComponent — field type coverage', () => {
  it('renders text/toggle/select for known types and nothing for an unknown one, without breaking the rest', () => {
    const fields: FieldDef[] = [
      { key: 'name', type: 'text', labelKey: 'x.name' },
      { key: 'weird', type: 'mystery' as FieldDef['type'], labelKey: 'x.weird' },
      { key: 'enabled', type: 'toggle', labelKey: 'x.enabled' },
      {
        key: 'engine',
        type: 'select',
        labelKey: 'x.engine',
        options: [
          { value: 'a', labelKey: 'x.a' },
          { value: 'b', labelKey: 'x.b' },
        ],
      },
    ];
    const fixture = createComponent(fields, {});
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelectorAll('input[type="text"]').length).toBe(1);
    expect(host.querySelectorAll('input[type="checkbox"]').length).toBe(1);
    expect(host.querySelectorAll('select').length).toBe(1);
    expect(host.querySelectorAll('select option').length).toBe(2);

    // The unknown field contributes zero DOM nodes: 3 matched cases, 3 children.
    const container = host.querySelector(':scope > div');
    expect(container?.children.length).toBe(3);
  });

  it('does not throw when every field is an unknown type', () => {
    const fields: FieldDef[] = [{ key: 'x', type: 'nope' as FieldDef['type'], labelKey: 'x.x' }];
    expect(() => createComponent(fields, {})).not.toThrow();
  });
});

describe('SchemaFormComponent — secret fields never re-send an unchanged value', () => {
  const secretField: FieldDef = {
    key: 'password',
    type: 'password',
    labelKey: 'x.password',
    secret: true,
  };

  it('keeps an untouched secret out of value() — the property a save must preserve', () => {
    // The server never echoes a stored secret, so the seed is always ''.
    const fixture = createComponent([secretField], {});
    expect(fixture.componentInstance.value()['password']).toBeUndefined();
    expect('password' in fixture.componentInstance.value()).toBe(false);
  });

  it('writes a typed secret, then omits the key again once cleared back to blank', () => {
    const fixture = createComponent([secretField], {});
    const input = fixture.nativeElement.querySelector('input[type="password"]') as HTMLInputElement;

    setInputAndDispatch(input, 'newpass');
    expect(fixture.componentInstance.value()['password']).toBe('newpass');

    setInputAndDispatch(input, '');
    expect('password' in fixture.componentInstance.value()).toBe(false);
  });

  it('does not enforce required on a secret field — blank is ambiguous, not invalid', () => {
    const fixture = createComponent(
      [{ ...secretField, required: true }],
      {},
    );
    expect(fixture.nativeElement.querySelector('.text-error')).toBeNull();
  });
});

describe('SchemaFormComponent — non-secret fields round-trip exactly what is typed', () => {
  it('writes an empty non-secret text field as "", not omitted', () => {
    const field: FieldDef = { key: 'name', type: 'text', labelKey: 'x.name' };
    const fixture = createComponent([field], { name: 'x' });
    const input = fixture.nativeElement.querySelector('input[type="text"]') as HTMLInputElement;

    setInputAndDispatch(input, '');
    expect(fixture.componentInstance.value()['name']).toBe('');
    expect('name' in fixture.componentInstance.value()).toBe(true);
  });

  it('coerces a number field to a real number', () => {
    const field: FieldDef = { key: 'n', type: 'number', labelKey: 'x.n' };
    const fixture = createComponent([field], {});
    const input = fixture.nativeElement.querySelector('input[type="number"]') as HTMLInputElement;

    setInputAndDispatch(input, '42');
    expect(fixture.componentInstance.value()['n']).toBe(42);
  });

  it('updates value() on toggle change', () => {
    const field: FieldDef = { key: 'enabled', type: 'toggle', labelKey: 'x.enabled' };
    const fixture = createComponent([field], { enabled: false });
    const checkbox = fixture.nativeElement.querySelector('input[type="checkbox"]') as HTMLInputElement;

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.value()['enabled']).toBe(true);
  });

  it('updates value() on select change', () => {
    const field: FieldDef = {
      key: 'engine',
      type: 'select',
      labelKey: 'x.engine',
      options: [
        { value: 'a', labelKey: 'x.a' },
        { value: 'b', labelKey: 'x.b' },
      ],
    };
    const fixture = createComponent([field], { engine: 'a' });
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;

    (select.options[1] as HTMLOptionElement).selected = true;
    select.dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.value()['engine']).toBe('b');
  });
});

describe('SchemaFormComponent — required validation', () => {
  it('flags a blank required field and clears once filled', () => {
    const field: FieldDef = { key: 'name', type: 'text', labelKey: 'x.name', required: true };
    const fixture = createComponent([field], {});
    expect(fixture.nativeElement.querySelector('.text-error')).not.toBeNull();

    fixture.componentRef.setInput('value', { name: 'x' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.text-error')).toBeNull();
  });

  it('does not flag a non-required field', () => {
    const field: FieldDef = { key: 'name', type: 'text', labelKey: 'x.name' };
    const fixture = createComponent([field], {});
    expect(fixture.nativeElement.querySelector('.text-error')).toBeNull();
  });
});

it('VERDICT: reads a stringified boolean, so a stored "false" renders off', async () => {
  const fields: FieldDef[] = [
    { key: 'a', type: 'toggle', labelKey: 'x.a' },
    { key: 'b', type: 'toggle', labelKey: 'x.b' },
  ];
  const fixture = createComponent(fields, { a: 'false', b: 'true' });
  // `ngModel` writes to the DOM asynchronously; a single detectChanges leaves both unchecked.
  await fixture.whenStable();

  const boxes = Array.from(fixture.nativeElement.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
  expect(boxes.map((b) => b.checked)).toEqual([false, true]);
});
