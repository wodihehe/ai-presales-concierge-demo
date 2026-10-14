import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceStatus, validateSchedule } from '../server/schedule.js';

const weekday = { timezone: 'Asia/Hong_Kong', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [] };

test('empty or absent schedule never invents a service window', () => {
  for (const config of [null, { ...weekday, days: [] }]) {
    assert.deepEqual(serviceStatus(config, new Date('2026-09-23T02:00:00Z')), { isOpen: false, nextOpen: null, label: '人工服务时间尚未设置' });
  }
});

test('Hong Kong weekday opening and exact closing boundary', () => {
  assert.equal(serviceStatus(weekday, new Date('2026-09-23T01:00:00Z')).isOpen, true);
  assert.equal(serviceStatus(weekday, new Date('2026-09-23T09:59:59Z')).isOpen, true);
  const closed = serviceStatus(weekday, new Date('2026-09-23T10:00:00Z'));
  assert.equal(closed.isOpen, false);
  assert.equal(closed.nextOpen, '2026-09-24T01:00:00.000Z');
});

test('weekends and several rest days are skipped, not promised tomorrow', () => {
  const config = { ...weekday, holidays: ['2026-09-28', '2026-09-29'] };
  const state = serviceStatus(config, new Date('2026-09-25T10:00:00Z'));
  assert.equal(state.nextOpen, '2026-09-30T01:00:00.000Z');
  assert.match(state.label, /休息日除外/);
});

test('long rest-date sequence and single weekday still finds the real next opening', () => {
  const config = { ...weekday, days: [1], holidays: ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'] };
  assert.equal(serviceStatus(config, new Date('2026-09-23T02:00:00Z')).nextOpen, '2026-10-26T01:00:00.000Z');
});

test('overnight shifts belong to their starting weekday; rest dates close the entire day', () => {
  const overnight = { ...weekday, days: [1], start: '22:00', end: '02:00' };
  assert.equal(serviceStatus(overnight, new Date('2026-09-21T14:00:00Z')).isOpen, true);
  assert.equal(serviceStatus(overnight, new Date('2026-09-21T17:30:00Z')).isOpen, true);
  assert.equal(serviceStatus(overnight, new Date('2026-09-21T18:00:00Z')).isOpen, false);
  assert.equal(serviceStatus({ ...overnight, holidays: ['2026-09-22'] }, new Date('2026-09-21T17:30:00Z')).isOpen, false);
  assert.equal(serviceStatus({ ...overnight, holidays: ['2026-09-21'] }, new Date('2026-09-21T17:30:00Z')).isOpen, false);
});

test('half-hour timezone returns an accurate UTC next opening', () => {
  assert.equal(serviceStatus({ ...weekday, timezone: 'Asia/Kolkata' }, new Date('2026-09-23T02:00:00Z')).nextOpen, '2026-09-23T03:30:00.000Z');
});

test('DST spring gap begins at the first actual minute inside the configured window', () => {
  const dst = { timezone: 'America/New_York', days: [0], start: '02:30', end: '04:00', holidays: [] };
  assert.equal(serviceStatus(dst, new Date('2026-03-08T06:00:00Z')).nextOpen, '2026-03-08T07:00:00.000Z');
  assert.equal(serviceStatus(dst, new Date('2026-03-08T07:00:00Z')).isOpen, true);
});

test('DST repeated hour can find the second real opening on the same date', () => {
  const dst = { timezone: 'America/New_York', days: [0], start: '01:15', end: '01:30', holidays: [] };
  assert.equal(serviceStatus(dst, new Date('2026-11-01T05:45:00Z')).nextOpen, '2026-11-01T06:15:00.000Z');
  assert.equal(serviceStatus(dst, new Date('2026-11-01T06:20:00Z')).isOpen, true);
});

test('schedule validation rejects invalid values before they can be saved', () => {
  for (const bad of [
    { ...weekday, timezone: 'Nowhere/Fictional' }, { ...weekday, days: [7] },
    { ...weekday, days: ['1'] }, { ...weekday, start: '24:00' },
    { ...weekday, start: '9:00' }, { ...weekday, start: '18:00' },
    { ...weekday, holidays: ['2026-02-30'] }, { ...weekday, holidays: ['tomorrow'] },
  ]) assert.throws(() => validateSchedule(bad), error => error.status === 400);
  assert.throws(() => serviceStatus(weekday, new Date('invalid')), error => error.status === 400);
  assert.deepEqual(validateSchedule({ ...weekday, days: [1, 1], holidays: ['2026-09-23', '2026-09-23'] }).days, [1]);
});
