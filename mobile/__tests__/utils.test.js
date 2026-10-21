import { normalizeIranMobile } from '../src/utils/phone';
import { dayKey, formatDayLabel, formatConversationTime } from '../src/utils/time';

describe('normalizeIranMobile', () => {
  test.each([
    ['09123456789', '09123456789'],
    ['۰۹۱۲۳۴۵۶۷۸۹', '09123456789'],
    ['+989123456789', '09123456789'],
    ['00989123456789', '09123456789'],
    ['989123456789', '09123456789'],
    ['9123456789', '09123456789'],
    ['0912 345 6789', '09123456789'],
    ['(0912)-345-6789', '09123456789'],
  ])('%s normalizes to %s', (input, expected) => {
    expect(normalizeIranMobile(input)).toBe(expected);
  });

  test.each(['12345', '08123456789', '', null, 9123456789])('rejects %p', input => {
    expect(normalizeIranMobile(input)).toBeNull();
  });
});

describe('time helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-21T12:00:00'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('dayKey uses the local calendar day', () => {
    expect(dayKey(new Date('2026-10-21T08:00:00'))).toBe('2026-9-21');
  });

  test('labels today and yesterday', () => {
    expect(formatDayLabel(new Date('2026-10-21T08:00:00'))).toBe('امروز');
    expect(formatDayLabel(new Date('2026-10-20T08:00:00'))).toBe('دیروز');
    expect(formatConversationTime(new Date('2026-10-20T08:00:00'))).toBe('دیروز');
  });

  test('omits a missing conversation timestamp', () => {
    expect(formatConversationTime(null)).toBe('');
  });
});
