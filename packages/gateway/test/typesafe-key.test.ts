import assert from 'node:assert/strict';
import { it } from 'node:test';
import { resolveTypesafeApiKey } from '@weave/gateway';

it('resolves the preferred TypeSafe key before the legacy fallback', () => {
  assert.equal(
    resolveTypesafeApiKey({ TYPESAFE_API_KEY: ' \tpreferred\n', TYPESAFE_AI_API_KEY: 'legacy' }),
    'preferred',
  );
  assert.equal(resolveTypesafeApiKey({ TYPESAFE_AI_API_KEY: ' \tlegacy\n' }), 'legacy');
  for (const absent of ['', ' \t\n']) {
    assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: absent, TYPESAFE_AI_API_KEY: ' \tlegacy\n' }), 'legacy');
    assert.equal(resolveTypesafeApiKey({ TYPESAFE_API_KEY: absent, TYPESAFE_AI_API_KEY: absent }), undefined);
    assert.equal(resolveTypesafeApiKey({ TYPESAFE_AI_API_KEY: absent }), undefined);
  }
  assert.equal(resolveTypesafeApiKey({}), undefined);
});
