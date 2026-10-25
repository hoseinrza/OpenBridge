// Standard EICAR antivirus test string. It is harmless to execute and is
// recognized by antivirus engines; used only to verify scan plumbing.
exports.EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

// Message text is sealed at rest with the server-held content key, so a suite
// that reads a row straight from the database has to open it the way the
// application does. Kept lazy: the suites set CONTENT_KEY in their own headers,
// and requiring the built cipher before `npm run build` would not be a test
// failure worth reading.
const FALLBACK_CONTENT_KEY = 'Y2ktb25seS1jb250ZW50LWtleS0zMi1ieXRlcy0wMDA=';
let cipher;
function contentCipher() {
  if (!cipher) {
    const { createContentCipher, loadContentKey } = require('../dist/common/content-crypto.js');
    cipher = createContentCipher(loadContentKey(process.env.CONTENT_KEY || FALLBACK_CONTENT_KEY));
  }
  return cipher;
}

// The marker, not a key, is what says a row went through the sealing path.
exports.SEALED_PREFIX = 'obx1.';
exports.isSealed = payload => typeof payload === 'string' && payload.startsWith('obx1.');
exports.openStoredText = (conversationId, payload) => contentCipher().openText(conversationId, payload);
