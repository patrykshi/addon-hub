import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProfileCache,
  isValidProfileId,
  parseFirestoreProfileDoc,
} from './profileStore.ts';

test('isValidProfileId enforces 20-64 alphanumeric/dash/underscore IDs', () => {
  assert.equal(isValidProfileId('short_id'), false);
  assert.equal(isValidProfileId('prf_0123456789abcdefghij'), true);
  assert.equal(isValidProfileId('../bad/path/1234567890123456'), false);
});

test('parseFirestoreProfileDoc decodes Firestore REST document into sanitized StreamHubConfig', () => {
  const parsed = parseFirestoreProfileDoc({
    name: 'projects/p/databases/d/documents/profiles/prf_0123456789abcdefghij',
    fields: {
      name: { stringValue: 'Meu Nuvio BR' },
      addons: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  url: { stringValue: 'https://torrentio.strem.fun/manifest.json' },
                  name: { stringValue: 'Torrentio' },
                },
              },
            },
          ],
        },
      },
      resolutions: {
        arrayValue: {
          values: [{ stringValue: '2160p' }, { stringValue: '1080p' }],
        },
      },
      allowUnknownRes: { booleanValue: false },
      languageMode: { stringValue: 'only_ptbr' },
      strictMetaMatch: { booleanValue: true },
      timeoutMs: { integerValue: '5000' },
    },
  });

  assert.ok(parsed);
  assert.equal(parsed.name, 'Meu Nuvio BR');
  assert.equal(parsed.config.addons.length, 1);
  assert.equal(parsed.config.addons[0].url, 'https://torrentio.strem.fun/manifest.json');
  assert.deepEqual(parsed.config.resolutions, ['2160p', '1080p']);
  assert.equal(parsed.config.allowUnknownRes, false);
  assert.equal(parsed.config.languageMode, 'only_ptbr');
  assert.equal(parsed.config.timeoutMs, 5000);
});

test('ProfileCache caches configs, respects TTL, and supports instant invalidation', () => {
  const cache = new ProfileCache(1000, 10);
  const cfg = parseFirestoreProfileDoc({
    fields: {
      name: { stringValue: 'Test' },
      addons: { arrayValue: { values: [] } },
      resolutions: { arrayValue: { values: [{ stringValue: '1080p' }] } },
      allowUnknownRes: { booleanValue: true },
      languageMode: { stringValue: 'prioritize_ptbr' },
      strictMetaMatch: { booleanValue: true },
      timeoutMs: { integerValue: 6500 },
    },
  })!.config;

  cache.set('prf_0123456789abcdefghij', cfg, 100);
  assert.ok(cache.get('prf_0123456789abcdefghij', 500));
  assert.equal(cache.get('prf_0123456789abcdefghij', 1200), undefined);

  cache.set('prf_0123456789abcdefghij', cfg, 2000);
  cache.invalidate('prf_0123456789abcdefghij');
  assert.equal(cache.get('prf_0123456789abcdefghij', 2001), undefined);
});
