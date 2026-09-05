#!/usr/bin/env node
/**
 * Import every Prowlarr indexer into Fliks as a Torznab indexer.
 *
 * Each Prowlarr indexer is proxied at {prowlarrUrl}/{indexerId}/api and
 * authenticated with the Prowlarr API key, so one Fliks torznab indexer
 * per Prowlarr indexer is a straight 1:1 mapping.
 *
 * Usage:
 *   node tools/import-prowlarr-indexers.mjs \
 *     --prowlarr-url http://localhost:9696 --prowlarr-key XXXX \
 *     --fliks-url http://localhost:3000 --fliks-user admin --fliks-pass secret \
 *     [--dry-run] [--update] [--include-disabled] [--min-seeders 0] [--request-delay 2]
 *     [--rules rules.json] [--plugin-id fliks.download]
 *
 * Every flag also reads from an env var: PROWLARR_URL, PROWLARR_KEY,
 * FLIKS_URL, FLIKS_USER, FLIKS_PASS.
 *
 * Per-tracker rules: Prowlarr's own seed ratio / seed time fields are carried
 * over when present, and --rules lets you override anything per indexer.
 *
 * A Prowlarr behind an internally-signed certificate needs the CA passed to Node
 * explicitly — `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` — since Node
 * ships its own trust store rather than reading the system one. Note that Fliks
 * itself must reach the same URL: plugins are spawned with an allowlisted env that
 * carries no CA override, so a self-signed Prowlarr is unreachable from the plugin
 * whatever this script writes. Prefer a URL the plugin can already validate.
 */

import { readFileSync } from 'node:fs';

const args = parseArgs(process.argv.slice(2));

if (args['help'] || args['h']) {
  console.log(
    [
      'Import every Prowlarr indexer into Fliks as a Torznab indexer.',
      '',
      'node tools/import-prowlarr-indexers.mjs \\',
      '  --prowlarr-url http://localhost:9696 --prowlarr-key XXXX \\',
      '  --fliks-url http://localhost:3000 --fliks-user admin --fliks-pass secret \\',
      '  [--dry-run] [--update] [--include-disabled] [--min-seeders 0] [--request-delay 2]',
      '  [--rules rules.json]',
      '',
      'Env fallbacks: PROWLARR_URL, PROWLARR_KEY, FLIKS_URL, FLIKS_USER, FLIKS_PASS.',
      '',
      '  --dry-run           print what would happen, change nothing',
      '  --update            overwrite indexers already present (matched on baseUrl)',
      '  --include-disabled  also import indexers disabled in Prowlarr',
      '  --plugin-id ID      acquisition plugin that owns indexers (default fliks.download)',
      '  --seed-ratio N      default seedRatio when Prowlarr has none (default 999,',
      '                      i.e. never delete on ratio — Fliks itself defaults to 1)',
      '  --rules FILE        JSON of per-indexer overrides, keyed by Prowlarr name:',
      '',
      '    {',
      '      "_default":  { "requestDelay": 5 },',
      '      "SomeTracker": {',
      '        "requestDelay": 30,',
      '        "enableRss": false,',
      '        "settings": { "seedRatio": 2, "maxRetentionDays": 14, "minSeeders": 3 }',
      '      }',
      '    }',
    ].join('\n'),
  );
  process.exit(0);
}

const prowlarrUrl = trimSlash(args['prowlarr-url'] ?? process.env.PROWLARR_URL);
const prowlarrKey = args['prowlarr-key'] ?? process.env.PROWLARR_KEY;
const fliksUrl = trimSlash(args['fliks-url'] ?? process.env.FLIKS_URL);
const fliksUser = args['fliks-user'] ?? process.env.FLIKS_USER;
const fliksPass = args['fliks-pass'] ?? process.env.FLIKS_PASS;

// Indexers left core in #930 — they now belong to the `fliks.download` plugin,
// reached through core's plugin proxy at /api/plugins/<id>/*.
const pluginId = args['plugin-id'] ?? process.env.FLIKS_PLUGIN_ID ?? 'fliks.download';
const indexersPath = `/api/plugins/${pluginId}/indexers`;

const dryRun = Boolean(args['dry-run']);
const doUpdate = Boolean(args['update']);
const includeDisabled = Boolean(args['include-disabled']);
const minSeeders = Number(args['min-seeders'] ?? 0);
const requestDelay = Number(args['request-delay'] ?? 2);
// Fliks deletes a completed torrent as soon as `ratio >= seedRatio`, and treats
// a missing seedRatio as 1.0 — a hit-and-run on most private trackers. Default
// to a ratio nothing reaches, so seeding stops only on an explicit rule.
const defaultSeedRatio = Number(args['seed-ratio'] ?? 999);
const rules = args['rules'] ? loadRules(String(args['rules'])) : {};

const missing = Object.entries({
  '--prowlarr-url': prowlarrUrl,
  '--prowlarr-key': prowlarrKey,
  '--fliks-url': fliksUrl,
  '--fliks-user': fliksUser,
  '--fliks-pass': fliksPass,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`Missing required option(s): ${missing.join(', ')}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});

async function main() {
  const remote = await fetchProwlarrIndexers();
  console.log(`Prowlarr: ${remote.length} indexer(s) found.`);

  const candidates = remote.filter((ix) => {
    if (ix.protocol && ix.protocol !== 'torrent') {
      console.log(`  skip ${ix.name}: protocol=${ix.protocol} (Fliks torznab is torrent-only)`);
      return false;
    }
    if (!includeDisabled && ix.enable === false) {
      console.log(`  skip ${ix.name}: disabled in Prowlarr (use --include-disabled)`);
      return false;
    }
    return true;
  });

  if (!candidates.length) {
    console.log('Nothing to import.');
    return;
  }

  const token = await fliksLogin();
  const existing = await fliksGet(indexersPath, token);
  // API responses redact `apiKey` but keep `baseUrl`, which is the stable identity here.
  const byBaseUrl = new Map(
    existing.map((ix) => [trimSlash(String(ix.settings?.baseUrl ?? '')), ix]),
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const ix of candidates) {
    const baseUrl = `${prowlarrUrl}/${ix.id}/api`;
    const body = applyRules(ix.name, {
      name: ix.name,
      implementation: 'torznab',
      priority: clampPriority(ix.priority),
      requestDelay,
      enabled: ix.enable !== false,
      enableSearch: true,
      enableRss: true,
      settings: {
        baseUrl,
        apiKey: prowlarrKey,
        minSeeders,
        ...seedingRules(ix),
      },
    });

    const match = byBaseUrl.get(baseUrl);

    if (match && !doUpdate) {
      console.log(`  = ${ix.name}: already in Fliks (#${match.id}), skipping`);
      skipped++;
      continue;
    }

    if (dryRun) {
      const s = body.settings;
      console.log(
        `  ${match ? '~' : '+'} ${ix.name} -> ${baseUrl}` +
          ` [delay ${body.requestDelay}s, ratio ${s.seedRatio}` +
          `${s.maxRetentionDays ? `, retention ${s.maxRetentionDays}d` : ''}` +
          `, minSeeders ${s.minSeeders}${body.enableRss ? '' : ', no RSS'}] (dry run)`,
      );
      match ? updated++ : created++;
      continue;
    }

    try {
      if (match) {
        await fliksSend('PUT', `${indexersPath}/${match.id}`, token, body);
        console.log(`  ~ ${ix.name}: updated (#${match.id})`);
        updated++;
      } else {
        const res = await fliksSend('POST', indexersPath, token, body);
        console.log(`  + ${ix.name}: created (#${res.id})`);
        created++;
      }
    } catch (err) {
      console.error(`  ! ${ix.name}: ${err.message}`);
    }
  }

  console.log(
    `\nDone${dryRun ? ' (dry run)' : ''}: ${created} created, ${updated} updated, ${skipped} skipped.`,
  );
}

async function fetchProwlarrIndexers() {
  const res = await fetch(`${prowlarrUrl}/api/v1/indexer`, {
    headers: { 'X-Api-Key': prowlarrKey },
  });
  if (!res.ok) {
    throw new Error(`Prowlarr GET /api/v1/indexer -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fliksLogin() {
  const res = await fetch(`${fliksUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: fliksUser, password: fliksPass }),
  });
  if (!res.ok) {
    throw new Error(`Fliks login -> ${res.status} ${await res.text()}`);
  }
  const { accessToken } = await res.json();
  if (!accessToken) throw new Error('Fliks login returned no accessToken');
  return accessToken;
}

async function fliksGet(path, token) {
  const res = await fetch(`${fliksUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function fliksSend(method, path, token, body) {
  const res = await fetch(`${fliksUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Prowlarr keeps per-indexer seeding rules in `fields`, as
 *  `torrentBaseSettings.seedRatio` (ratio) and `.seedTime` (minutes).
 *  Fliks expresses the same rules as seedRatio + maxRetentionDays, and
 *  removes on whichever fires first — the same "ratio OR time" semantics. */
function seedingRules(ix) {
  const field = (suffix) => {
    const f = (ix.fields ?? []).find((x) => String(x.name ?? '').endsWith(suffix));
    const n = Number(f?.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const out = { seedRatio: field('seedRatio') ?? defaultSeedRatio };
  const seedMinutes = field('seedTime');
  // Fliks' retention is day-granular, so round up rather than under-seed.
  if (seedMinutes) out.maxRetentionDays = Math.ceil(seedMinutes / 1440);
  return out;
}

/** Merge `_default` then the per-name entry from the rules file over `body`.
 *  `settings` merges key by key; everything else replaces. */
function applyRules(name, body) {
  for (const override of [rules['_default'], rules[name]]) {
    if (!override) continue;
    const { settings, ...rest } = override;
    Object.assign(body, rest);
    Object.assign(body.settings, settings ?? {});
  }
  return body;
}

function loadRules(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    console.log(`Rules: ${Object.keys(parsed).length} entr(ies) from ${path}`);
    return parsed;
  } catch (err) {
    console.error(`Cannot read rules file ${path}: ${err.message}`);
    process.exit(1);
  }
}

function clampPriority(p) {
  const n = Number(p);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 25;
}

function trimSlash(url) {
  return url ? String(url).replace(/\/+$/, '') : url;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
