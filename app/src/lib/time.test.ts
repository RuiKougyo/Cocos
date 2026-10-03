import { describe, expect, it } from 'vitest';
import { businessToday, datesBetween, formatDate, formatMin, overlap, parsePickerValue, toInputValue } from './time';

describe('parsePickerValue', () => {
  it('treats 06:00 and later as the same business day', () => {
    expect(parsePickerValue('06:00')).toEqual({ ok: true, min: 360, rounded: false });
    expect(parsePickerValue('17:05')).toEqual({ ok: true, min: 1025, rounded: false });
  });
  it('treats times before 06:00 as the next day', () => {
    expect(parsePickerValue('00:00')).toEqual({ ok: true, min: 1440, rounded: false });
    expect(parsePickerValue('01:30')).toEqual({ ok: true, min: 1530, rounded: false });
    expect(parsePickerValue('02:00')).toEqual({ ok: true, min: 1560, rounded: false });
  });
  it('rejects 02:05-05:55', () => {
    expect(parsePickerValue('02:05').ok).toBe(false);
    expect(parsePickerValue('05:55').ok).toBe(false);
  });
  it('rounds to 5 minutes', () => {
    expect(parsePickerValue('17:03')).toEqual({ ok: true, min: 1025, rounded: true });
    expect(parsePickerValue('17:02')).toEqual({ ok: true, min: 1020, rounded: true });
    expect(parsePickerValue('23:58')).toEqual({ ok: true, min: 1440, rounded: true });
  });
});

describe('formatting', () => {
  it('formats minutes with 翌 for after midnight', () => {
    expect(formatMin(1025)).toBe('17:05');
    expect(formatMin(1530)).toBe('翌1:30');
    expect(formatMin(1440)).toBe('翌0:00');
    expect(toInputValue(1530)).toBe('01:30');
  });
  it('formats dates', () => {
    expect(formatDate('2026-10-03')).toBe('10/3(土)');
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  it('business day rolls over at 06:00', () => {
    expect(businessToday(new Date(2026, 9, 4, 1, 30))).toBe('2026-10-03');
    expect(businessToday(new Date(2026, 9, 4, 6, 0))).toBe('2026-10-04');
  });
  it('computes overlap', () => {
    expect(overlap(1020, 1320, 960, 1500)).toEqual([1020, 1320]);
    expect(overlap(600, 700, 700, 800)).toBeNull();
  });
});
