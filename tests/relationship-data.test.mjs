import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, distanceDuration, meetingDayCount, meetingYears, normalizeStory, parseDay, todayInZone } from '../assets/relationship-data.mjs';

const story = (meetings = [], longDistancePeriods = []) => normalizeStory({ meetings, longDistancePeriods });

test('single dates, inclusive ranges and overlapping records count unique meeting days', () => {
    const data = story([
        { startDate: '2026-10-01', endDate: '2026-10-07' },
        { startDate: '2026-10-05', endDate: '2026-10-09' },
        { startDate: '2026-10-11' },
        { startDate: '2026-10-20', endDate: '2026-10-22' }
    ]);
    assert.equal(meetingDayCount(data.meetings, '2026-10-12'), 10);
    assert.equal(meetingDayCount(data.meetings, '2026-10-06'), 6);
    assert.equal(meetingDayCount(data.meetings, '2026-10-20'), 11);
});

test('cross-year and leap-day meetings retain the correct calendar dates', () => {
    const data = story([
        { startDate: '2023-12-31', endDate: '2024-01-02' },
        { startDate: '2024-02-28', endDate: '2024-03-01' }
    ]);
    assert.equal(meetingDayCount(data.meetings, '2024-03-01'), 6);
    const days = calendarDays(2024, data.meetings, '2024-03-01');
    assert.equal(days.length, 366);
    assert.equal(days.find((day) => day.date === '2024-02-29').state, 'met');
    assert.equal(days.filter((day) => day.state === 'met').length, 5);
});

test('future plans are visible without inflating completed meeting days', () => {
    const data = story([{ startDate: '2026-10-11', endDate: '2026-10-14', title: '相聚' }]);
    const days = calendarDays(2026, data.meetings, '2026-10-12');
    assert.equal(meetingDayCount(data.meetings, '2026-10-12'), 2);
    assert.equal(days.find((day) => day.date === '2026-10-12').state, 'met');
    assert.equal(days.find((day) => day.date === '2026-10-13').state, 'planned');
    assert.equal(days.find((day) => day.date === '2026-10-15').state, 'future');
});

test('minute-precision meetings retain both times and count overlapping calendar dates once', () => {
    const data = story([
        { startDate: '2026-10-11T23:30:00+08:00', endDate: '2026-10-12T00:15:00+08:00', title: '跨日相聚' },
        { startDate: '2026-10-12T09:05+08:00', endDate: '2026-10-12T10:45+08:00' },
        { startDate: '2026-10-12T11:30:00+08:00' }
    ]);
    const now = new Date('2026-10-12T12:00:00+08:00');
    assert.equal(meetingDayCount(data.meetings, '2026-10-12', now), 2);
    assert.equal(data.meetings[0].dateLabel, '2026-10-11 23:30 — 2026-10-12 00:15');
    assert.equal(data.meetings[1].dateLabel, '2026-10-12 09:05 — 2026-10-12 10:45');
    assert.equal(data.meetings[2].dateLabel, '2026-10-12 11:30');
    const day = calendarDays(2026, data.meetings, '2026-10-12', now).find((item) => item.date === '2026-10-11');
    assert.equal(day.state, 'met');
    assert.deepEqual(day.details, ['2026-10-11 23:30 — 2026-10-12 00:15 · 跨日相聚']);
});

test('a meeting later today stays planned until its exact start time', () => {
    const data = story([{ startDate: '2026-10-12T14:32+08:00', endDate: '2026-10-12T18:00+08:00' }]);
    const before = new Date('2026-10-12T14:31:59+08:00');
    const start = new Date('2026-10-12T14:32:00+08:00');
    const state = (now) => calendarDays(2026, data.meetings, '2026-10-12', now).find((day) => day.date === '2026-10-12').state;
    assert.equal(meetingDayCount(data.meetings, '2026-10-12', before), 0);
    assert.equal(state(before), 'planned');
    assert.equal(meetingDayCount(data.meetings, '2026-10-12', start), 1);
    assert.equal(state(start), 'met');
    const mixed = story([{ startDate: '2026-10-12' }, { startDate: '2026-10-12T14:32+08:00' }]);
    assert.equal(meetingDayCount(mixed.meetings, '2026-10-12', before), 1);
    assert.equal(calendarDays(2026, mixed.meetings, '2026-10-12', before).find((day) => day.date === '2026-10-12').state, 'met');
});

test('meeting dates and displayed minutes follow the configured timezone across year boundaries', () => {
    const data = normalizeStory({
        timeZone: 'America/Los_Angeles',
        meetings: [{ startDate: '2026-01-01T00:30:00+08:00', endDate: '2026-01-01T02:15:00+08:00' }]
    });
    assert.equal(data.meetings[0].dateLabel, '2025-12-31 08:30 — 2025-12-31 10:15');
    assert.deepEqual(meetingYears(data.meetings, '2026-10-12'), [2026, 2025]);
    const days = calendarDays(2025, data.meetings, '2026-10-12', new Date('2026-10-12T12:00:00Z'));
    assert.equal(days.find((day) => day.date === '2025-12-31').state, 'met');
});

test('calendar years include only recorded years and the current year, including cross-year ranges', () => {
    assert.deepEqual(meetingYears([], '2026-10-12'), [2026]);
    assert.deepEqual(meetingYears(story([{ startDate: '2026-02-02', endDate: '2026-02-04' }]).meetings, '2026-10-12'), [2026]);
    assert.deepEqual(meetingYears(story([{ startDate: '2024-01-01' }, { startDate: '2027-01-01' }]).meetings, '2026-10-12'), [2027, 2026, 2024]);
    assert.deepEqual(meetingYears(story([{ startDate: '2024-12-31', endDate: '2026-01-01' }]).meetings, '2026-10-12'), [2026, 2025, 2024]);
});

test('invalid meeting clock times and reversed times on the same day are rejected', () => {
    for (const startDate of ['2026-02-29T10:00+08:00', '2026-10-12T24:00+08:00', '2026-10-12T12:60+08:00', '2026-10-12T12:30']) {
        assert.throws(() => story([{ startDate }]));
    }
    assert.throws(() => story([{ startDate: '2026-10-12T14:32+08:00', endDate: '2026-10-12T14:31+08:00' }]));
    assert.throws(() => story([{ startDate: '2026-10-12T14:32+08:00', endDate: '2026-10-12T06:31Z' }]));
});

test('distance starts on day 1 at the specified Beijing time', () => {
    const data = story([], [{ startAt: '2025-06-01T09:00:00+08:00', endAt: null }]);
    assert.equal(distanceDuration(data.periods, new Date('2025-06-01T00:59:59Z')).days, 0);
    assert.deepEqual(distanceDuration(data.periods, new Date('2025-06-01T01:00:00Z')), {
        days: 1, hours: 0, minutes: 0, seconds: 0, milliseconds: 0
    });
    assert.equal(distanceDuration(data.periods, new Date('2025-06-02T00:59:59Z')).days, 1);
    assert.equal(distanceDuration(data.periods, new Date('2025-06-02T01:00:00Z')).days, 2);
});

test('overlapping distance periods count once and completed periods stop increasing', () => {
    const data = story([], [
        { startAt: '2025-06-01T09:00:00+08:00', endAt: '2025-06-03T09:00:00+08:00' },
        { startAt: '2025-06-02T09:00:00+08:00', endAt: '2025-06-04T09:00:00+08:00' },
        { startAt: '2025-06-06T09:00:00+08:00', endAt: null }
    ]);
    assert.equal(distanceDuration(data.periods, new Date('2025-06-07T01:00:00Z')).milliseconds, 4 * 86400000);
    assert.equal(distanceDuration(data.periods, new Date('2025-06-07T01:00:00Z')).days, 5);
});

test('Shanghai calendar day is independent of the visitor timezone', () => {
    assert.equal(todayInZone('Asia/Shanghai', new Date('2026-10-11T16:00:00Z')), '2026-10-12');
    assert.equal(todayInZone('Asia/Shanghai', new Date('2026-10-11T15:59:59Z')), '2026-10-11');
});

test('missing dates stay unknown and missing meeting records count zero', () => {
    const data = story();
    assert.equal(distanceDuration(data.periods), null);
    assert.equal(meetingDayCount(data.meetings, '2026-10-12'), 0);
    assert.equal(data.distanceKm, null);
});

test('distance is configurable per story and rejects invalid kilometer values', () => {
    assert.equal(normalizeStory({ distanceKm: 180 }).distanceKm, 180);
    assert.equal(normalizeStory({ distanceKm: 0 }).distanceKm, 0);
    for (const distanceKm of [-1, '180', Infinity, 100001]) assert.throws(() => normalizeStory({ distanceKm }));
});

test('invalid dates and reversed ranges are rejected instead of silently changing statistics', () => {
    assert.throws(() => parseDay('2026-02-29'));
    assert.throws(() => parseDay('2026-13-01'));
    assert.throws(() => story([{ startDate: '2026-10-07', endDate: '2026-10-01' }]));
    assert.throws(() => story([], [{ startAt: '2025-06-01T25:00:00+08:00' }]));
    assert.throws(() => story([], [{ startAt: '2026-05-01T09:00:00' }]));
});
