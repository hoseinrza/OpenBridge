// Hermes has crypto.getRandomValues (Expo polyfills it) but no crypto.subtle.
// This file makes subtle a throwing trap, then runs the gate in it, so any
// accidental WebCrypto use fails loudly instead of passing on Node by luck.
// node --test gives every file its own process, which is what keeps the trap
// from leaking into the other gate tests.
const { webcrypto } = await import('node:crypto');
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    randomUUID: () => webcrypto.randomUUID(),
  },
});
Object.defineProperty(globalThis.crypto, 'subtle', {
  configurable: true,
  get() {
    throw new Error('crypto.subtle is not available on Hermes');
  },
});

const { test } = await import('node:test');
const assert = await import('node:assert/strict');
const { getCiphersuiteFromName } = await import('ts-mls');
const { pureCryptoProvider, SUPPORTED_CIPHERSUITES } = await import('./provider.js');
const { runMlsLifecycle } = await import('./lifecycle-harness.mjs');

for (const ciphersuite of SUPPORTED_CIPHERSUITES) {
  test(`pure provider needs no WebCrypto on ${ciphersuite}`, async () => {
    assert.throws(() => globalThis.crypto.subtle, /not available on Hermes/);
    const impl = await pureCryptoProvider.getCiphersuiteImpl(getCiphersuiteFromName(ciphersuite));
    const { checks } = await runMlsLifecycle({ alice: impl, bob: impl, carol: impl });
    for (const [name, passed] of Object.entries(checks)) {
      assert.equal(passed, true, `${ciphersuite}: ${name} failed without WebCrypto`);
    }
  });
}
