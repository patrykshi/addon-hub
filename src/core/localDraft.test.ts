import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from './config.ts';
import { parseLocalDraft, serializeLocalDraft } from './localDraft.ts';

test('serializeLocalDraft and parseLocalDraft round-trip config and active profile cleanly', () => {
  const raw = serializeLocalDraft(
    {
      ...DEFAULT_CONFIG,
      addons: [{ url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio' }],
      timeoutMs: 7500,
    },
    'prf_0123456789abcdefghij',
    'Meu Perfil',
  );

  const parsed = parseLocalDraft(raw);
  assert.ok(parsed);
  assert.equal(parsed.activeProfileId, 'prf_0123456789abcdefghij');
  assert.equal(parsed.activeProfileName, 'Meu Perfil');
  assert.equal(parsed.config.addons.length, 1);
  assert.equal(parsed.config.timeoutMs, 7500);
});

test('parseLocalDraft handles corrupted JSON safely', () => {
  assert.equal(parseLocalDraft('{broken-json'), null);
  assert.equal(parseLocalDraft(null), null);
});
