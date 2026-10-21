// Pure-JavaScript crypto provider for ts-mls.
//
// ts-mls's own providers route HPKE (and the MLS KDF) through WebCrypto, which
// React Native's Hermes engine does not have. This provider keeps every
// primitive in maintained packages — `hpke` implements the RFC 9180 key
// schedule, `@panva/hpke-noble` supplies noble-backed KEM/KDF/AEAD — and adds
// only the interface glue ts-mls expects. No cryptographic primitive is
// implemented in this file.
//
// The same provider is used on web and mobile on purpose: ts-mls's noble
// signature helper prefers WebCrypto when present and would then store Ed25519
// keys as PKCS#8 instead of a raw seed, so key material would differ per
// platform. Pinning noble gives one key format everywhere.
import * as HPKE from 'hpke';
import * as nobleHpke from '@panva/hpke-noble';
import { ed25519 } from '@noble/curves/ed25519.js';
import { makeHashImpl } from 'ts-mls/crypto/implementation/noble/makeHashImpl.js';
import { defaultRng } from 'ts-mls/crypto/implementation/noble/rng.js';

const KEMS = {
  'DHKEM-X25519-HKDF-SHA256': nobleHpke.KEM_DHKEM_X25519_HKDF_SHA256,
  'DHKEM-P256-HKDF-SHA256': nobleHpke.KEM_DHKEM_P256_HKDF_SHA256,
};
const KDFS = {
  'HKDF-SHA256': nobleHpke.KDF_HKDF_SHA256,
  'HKDF-SHA384': nobleHpke.KDF_HKDF_SHA384,
  'HKDF-SHA512': nobleHpke.KDF_HKDF_SHA512,
};
const AEADS = {
  AES128GCM: nobleHpke.AEAD_AES_128_GCM,
  AES256GCM: nobleHpke.AEAD_AES_256_GCM,
  CHACHA20POLY1305: nobleHpke.AEAD_ChaCha20Poly1305,
};

function pick(table, name, kind) {
  const factory = table[name];
  if (!factory) throw new Error(`pure provider has no ${kind} mapping for ${name}`);
  return factory;
}

function makeKdf(kdfFactory) {
  const kdf = kdfFactory();
  return {
    extract: (salt, ikm) => kdf.Extract(salt, ikm),
    expand: (prk, info, len) => kdf.Expand(prk, info, len),
    size: kdf.Nh,
  };
}

// ts-mls's Hpke interface <-> HPKE.CipherSuite. Key handles stay opaque to us.
function makeHpke(cs) {
  const suite = new HPKE.CipherSuite(
    pick(KEMS, cs.hpke.kem, 'KEM'),
    pick(KDFS, cs.hpke.kdf, 'KDF'),
    pick(AEADS, cs.hpke.aead, 'AEAD'),
  );
  const aead = pick(AEADS, cs.hpke.aead, 'AEAD')();
  const EMPTY = new Uint8Array(0);

  return {
    async seal(publicKey, plaintext, info, aad) {
      const r = await suite.Seal(publicKey, plaintext, { info, aad: aad ?? EMPTY });
      return { ct: r.ciphertext, enc: r.encapsulatedSecret };
    },
    open(privateKey, kemOutput, ciphertext, info, aad) {
      return suite.Open(privateKey, kemOutput, ciphertext, { info, aad: aad ?? EMPTY });
    },
    async exportSecret(publicKey, exporterContext, length, info) {
      const r = await suite.SendExport(publicKey, exporterContext, length, { info });
      return { enc: r.encapsulatedSecret, secret: r.exportedSecret };
    },
    importSecret(privateKey, exporterContext, kemOutput, length, info) {
      return suite.ReceiveExport(privateKey, kemOutput, exporterContext, length, { info });
    },
    importPrivateKey: (k) => suite.DeserializePrivateKey(k, true),
    importPublicKey: (k) => suite.DeserializePublicKey(k),
    exportPublicKey: (k) => suite.SerializePublicKey(k),
    exportPrivateKey: (k) => suite.SerializePrivateKey(k),
    async deriveKeyPair(ikm) {
      const { privateKey, publicKey } = await suite.DeriveKeyPair(ikm, true);
      return { privateKey, publicKey };
    },
    async generateKeyPair() {
      const { privateKey, publicKey } = await suite.GenerateKeyPair(true);
      return { privateKey, publicKey };
    },
    encryptAead: (key, nonce, aad, plaintext) => aead.Seal(key, nonce, aad ?? EMPTY, plaintext),
    decryptAead: (key, nonce, aad, ciphertext) => aead.Open(key, nonce, aad ?? EMPTY, ciphertext),
    keyLength: aead.Nk,
    nonceLength: aead.Nn,
  };
}

function makeSignature(algorithm) {
  if (algorithm !== 'Ed25519') {
    throw new Error(`pure provider does not support signature algorithm ${algorithm}`);
  }
  return {
    sign: (signKey, message) => ed25519.sign(message, signKey),
    verify: (publicKey, message, signature) => ed25519.verify(signature, message, publicKey),
    keygen: async () => {
      const signKey = ed25519.utils.randomSecretKey();
      return { signKey, publicKey: ed25519.getPublicKey(signKey) };
    },
  };
}

// MLS ciphersuites this provider can serve, by ts-mls ciphersuite name.
export const SUPPORTED_CIPHERSUITES = [
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519',
  'MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519',
];

export const pureCryptoProvider = {
  async getCiphersuiteImpl(cs) {
    if (!SUPPORTED_CIPHERSUITES.includes(cs.name)) {
      throw new Error(`pure provider does not support ciphersuite ${cs.name}`);
    }
    return {
      kdf: makeKdf(pick(KDFS, cs.hpke.kdf, 'KDF')),
      hash: makeHashImpl(cs.hash),
      signature: makeSignature(cs.signature),
      hpke: makeHpke(cs),
      rng: defaultRng,
      name: cs.name,
    };
  },
};
