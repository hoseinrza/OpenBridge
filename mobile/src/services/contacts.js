import * as Contacts from 'expo-contacts';
import { matchContacts } from './api';
import { normalizeIranMobile } from '../utils/phone';

// Keep this at or below CONTACT_MATCH_MAX_PHONES on the server; a bigger
// address book is sent in several requests instead of being truncated.
const CHUNK_SIZE = 500;

export async function ensureContactsAccess() {
  const current = await Contacts.getPermissionsAsync();
  if (current.granted) return { granted: true, canAskAgain: true };
  const requested = await Contacts.requestPermissionsAsync();
  return { granted: !!requested.granted, canAskAgain: !!requested.canAskAgain };
}

function nameOf(contact) {
  const parts = [contact.givenName, contact.familyName].filter(Boolean);
  return (contact.fullName || parts.join(' ')).trim();
}

/**
 * Reads the device address book and marks which entries have an OpenBridge
 * account. Names and numbers stay in memory on the device: only distinct
 * valid mobile numbers leave the phone, and the server answers with input
 * positions, so the mapping back to a contact happens here.
 */
export async function loadContactsWithAccounts() {
  const details = await Contacts.Contact.getAllDetails([
    Contacts.ContactField.FULL_NAME,
    Contacts.ContactField.GIVEN_NAME,
    Contacts.ContactField.FAMILY_NAME,
    Contacts.ContactField.PHONES,
  ]);

  const entries = details
    .map(contact => {
      const numbers = (contact.phones ?? []).map(phone => phone?.number).filter(Boolean);
      const mobiles = numbers.map(normalizeIranMobile).filter(Boolean);
      return { name: nameOf(contact), numbers, phone: mobiles[0] ?? null };
    })
    .filter(entry => entry.name || entry.phone);

  const distinct = [...new Set(entries.map(entry => entry.phone).filter(Boolean))];
  const userByPhone = new Map();

  for (let offset = 0; offset < distinct.length; offset += CHUNK_SIZE) {
    const chunk = distinct.slice(offset, offset + CHUNK_SIZE);
    const { matches } = await matchContacts(chunk);
    for (const match of matches) {
      if (chunk[match.index]) userByPhone.set(chunk[match.index], match.user);
    }
  }

  return {
    checked: distinct.length,
    withAccounts: entries
      .filter(entry => entry.phone && userByPhone.has(entry.phone))
      .map(entry => ({ ...entry, user: userByPhone.get(entry.phone) })),
    withoutAccounts: entries.filter(entry => !entry.phone || !userByPhone.has(entry.phone)),
  };
}
