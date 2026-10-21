// Phase 0 library gate, executable form. Proves that the pure-JS provider can
// drive a real MLS conversation, and that it is wire-compatible with the
// WebCrypto-backed provider ts-mls ships (so the glue in provider.js adds no
// protocol divergence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCiphersuiteFromName, nobleCryptoProvider } from 'ts-mls';
import { pureCryptoProvider, SUPPORTED_CIPHERSUITES } from './provider.js';
import { runMlsLifecycle } from './lifecycle-harness.mjs';

async function implFor(provider, name) {
  return provider.getCiphersuiteImpl(getCiphersuiteFromName(name));
}

for (const ciphersuite of SUPPORTED_CIPHERSUITES) {
  test(`pure provider runs the full MLS lifecycle on ${ciphersuite}`, async () => {
    const impl = await implFor(pureCryptoProvider, ciphersuite);
    const { checks, metrics } = await runMlsLifecycle({ alice: impl, bob: impl, carol: impl });
    for (const [name, passed] of Object.entries(checks)) {
      assert.equal(passed, true, `${ciphersuite}: ${name} failed`);
    }
    // Group state is per conversation and must fit the client storage we picked.
    assert.ok(metrics.stateRoundTripBytes < 16 * 1024, 'client state unexpectedly large');
  });
}

test('pure provider interoperates with the WebCrypto provider in both directions', async () => {
  const ciphersuite = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
  const web = await implFor(nobleCryptoProvider, ciphersuite);
  const pure = await implFor(pureCryptoProvider, ciphersuite);

  for (const [label, impls] of [
    ['web seals, pure opens', { alice: web, bob: pure, carol: pure }],
    ['pure seals, web opens', { alice: pure, bob: web, carol: web }],
  ]) {
    const { checks } = await runMlsLifecycle(impls);
    for (const [name, passed] of Object.entries(checks)) {
      assert.equal(passed, true, `${label}: ${name} failed`);
    }
  }
});
