import { parseManifest } from './manifest-parser';
import { minimalDataManifest, minimalProcessManifest } from './test-manifests';

function bytesOf(manifest: unknown): Buffer {
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

describe('parseManifest — i18n namespace ownership', () => {
  it('accepts the real, published fliks.webhooks 1.1.2 i18n dict unchanged', () => {
    const manifest = minimalDataManifest({
      id: 'fliks.webhooks',
      i18n: {
        en: {
          'webhooks.config.test': 'Send a test event',
          'webhooks.config.title': 'Webhook notifications',
          'webhooks.config.endpoint_url': 'Endpoint URL',
          'webhooks.config.endpoint_url_hint':
            'Fliks POSTs the event here over https. Nothing is sent while this is empty.',
        },
        fr: {
          'webhooks.config.test': 'Envoyer un événement de test',
          'webhooks.config.title': 'Notifications webhook',
          'webhooks.config.endpoint_url': "URL du point d'entrée",
          'webhooks.config.endpoint_url_hint':
            "Fliks y envoie l'événement en POST via https. Rien n'est envoyé tant que ce champ est vide.",
        },
      },
    });

    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });

  it('accepts a real excerpt of the published fliks.download i18n dict, including its deepest branches', () => {
    // Verbatim keys from the installed fliks.download manifest, spanning 2-, 3- and
    // 4-segment depths under its owned "download." namespace.
    const manifest = minimalProcessManifest(
      { 'plugin.js': 'x', 'logo.png': 'x' },
      {
        id: 'fliks.download',
        i18n: {
          en: {
            'download.config.title': 'General',
            'download.jobs.rss_sync': 'RSS sync',
            'download.config.indexers.title': 'Indexers',
            'download.config.indexers.stats.date': 'Date',
            'download.config.indexers.stats.avg_response': 'Avg response (ms)',
            'download.grab.errors.no_eligible_release': 'No eligible release was found',
          },
        },
      },
    );

    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });

  it('derives the owned namespace from the segment after the id\'s last dot', () => {
    const manifest = minimalDataManifest({ id: 'fliks.a', i18n: { en: { 'a.label': 'Label' } } });
    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });

  it('uses the whole id as the namespace when it has no dot', () => {
    const manifest = minimalDataManifest({ id: 'standalone', i18n: { en: { 'standalone.label': 'Label' } } });
    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });

  it('accepts a root of the plugin\'s own choosing, which need not be a segment of its id', () => {
    // A vendor prefix is a legitimate choice; the registry is what refuses a root already claimed.
    const manifest = minimalDataManifest({ id: 'acme.hello', i18n: { en: { 'acme.greeting': 'Hi' } } });
    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });

  it('VERDICT: refuses keys spread across more than one root, which is two claims in one manifest', () => {
    const manifest = minimalDataManifest({ id: 'fliks.a', i18n: { en: { 'a.one': 'One', 'nav.home': 'HACKED' } } });
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses a key equal to the namespace with no trailing segment', () => {
    const manifest = minimalDataManifest({ id: 'fliks.a', i18n: { en: { a: 'Label' } } });
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses when one locale is clean but another sits outside the namespace', () => {
    const manifest = minimalDataManifest({
      id: 'fliks.a',
      i18n: { en: { 'a.label': 'Label' }, fr: { 'nav.home': 'HACKED' } },
    });
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses a bare key that is a dotted ancestor of another key in the same dict', () => {
    // `insertValue('a.config', ...)` then `insertValue('a.config.title', ...)` needs
    // "a.config" to be an object by the second call — it is already a leaf string.
    const manifest = minimalDataManifest({
      id: 'fliks.a',
      i18n: { en: { 'a.config': 'General', 'a.config.title': 'Title' } },
    });
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses when the ancestor key appears after its descendant', () => {
    const manifest = minimalDataManifest({
      id: 'fliks.a',
      i18n: { en: { 'a.config.title': 'Title', 'a.config': 'General' } },
    });
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses a non-string leaf value', () => {
    const manifest = { ...minimalDataManifest({ id: 'fliks.a' }), i18n: { en: { 'a.label': 42 } } };
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('refuses a locale whose value is not an object', () => {
    const manifest = { ...minimalDataManifest({ id: 'fliks.a' }), i18n: { en: 'not-a-dict' } };
    expect(parseManifest(bytesOf(manifest))).toBeNull();
  });

  it('accepts a manifest with no i18n at all', () => {
    const manifest = minimalDataManifest({ id: 'fliks.a' });
    expect(parseManifest(bytesOf(manifest))).not.toBeNull();
  });
});

describe('parseManifest — ingestRoots floor', () => {
  function processManifest(ingestRoots: unknown) {
    return {
      ...minimalProcessManifest({ 'plugin.js': 'x', 'logo.png': 'x' }),
      ingestRoots,
    };
  }

  it('refuses the whole-filesystem root', () => {
    expect(parseManifest(bytesOf(processManifest(['/'])))).toBeNull();
  });

  it('refuses a relative root', () => {
    expect(parseManifest(bytesOf(processManifest(['media'])))).toBeNull();
  });

  it('refuses a root with a parent-directory segment', () => {
    expect(parseManifest(bytesOf(processManifest(['/media/../etc'])))).toBeNull();
  });

  it('refuses an empty string', () => {
    expect(parseManifest(bytesOf(processManifest(['']))))
      .toBeNull();
  });

  it('accepts a normal absolute root', () => {
    expect(parseManifest(bytesOf(processManifest(['/media/downloads'])))).not.toBeNull();
  });
});
