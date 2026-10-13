const DAY_MS = 86400000;

export function parseDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('日期需要使用 YYYY-MM-DD 格式');
    }
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
        throw new Error(`无效日期：${value}`);
    }
    return timestamp / DAY_MS;
}

export function formatDay(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function todayInZone(timeZone, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseInstant(value, label = '异地时间') {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) {
        throw new Error(`${label}需要带时区，例如 2026-05-01T09:00:00+08:00`);
    }
    parseDay(match[1]);
    const timestamp = Date.parse(value);
    const [hour, minute, second] = [Number(match[2]), Number(match[3]), Number(match[4] || 0)];
    if (!Number.isFinite(timestamp) || hour > 23 || minute > 59 || second > 59) {
        throw new Error(`无效时间：${value}`);
    }
    return timestamp;
}

function meetingDate(value, timeZone) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { day: parseDay(value), at: null, label: value };
    }
    const at = parseInstant(value, '见面时间');
    const date = new Date(at);
    const parts = new Intl.DateTimeFormat('en', {
        timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type).value;
    const day = todayInZone(timeZone, date);
    return { day: parseDay(day), at, label: `${day} ${part('hour')}:${part('minute')}` };
}

export function normalizeStory(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('记录配置格式错误');
    const timeZone = raw.timeZone || 'Asia/Shanghai';
    todayInZone(timeZone);
    const meetings = raw.meetings ?? [];
    const periods = raw.longDistancePeriods ?? [];
    if (!Array.isArray(meetings) || !Array.isArray(periods)) throw new Error('日期记录需要使用列表');
    const distanceKm = raw.distanceKm ?? null;
    if (distanceKm !== null && (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > 100000)) {
        throw new Error('两地距离需要是 0 到 100000 之间的公里数');
    }
    return {
        timeZone,
        distanceKm,
        locations: {
            person1: String(raw.locations?.person1 || '地点待记录'),
            person2: String(raw.locations?.person2 || '地点待记录')
        },
        meetings: meetings.map((record) => {
            const start = meetingDate(record.startDate, timeZone);
            const end = record.endDate ? meetingDate(record.endDate, timeZone) : start;
            if (end.day < start.day || (start.at !== null && end.at !== null && end.at < start.at)) {
                throw new Error('见面结束时间不能早于开始时间');
            }
            return {
                start: start.day, end: end.day, startAt: start.at, endAt: record.endDate ? end.at : null,
                dateLabel: start.label === end.label ? start.label : `${start.label} — ${end.label}`,
                title: String(record.title || '').trim()
            };
        }),
        periods: periods.map((record) => {
            const start = parseInstant(record.startAt);
            const end = record.endAt == null ? null : parseInstant(record.endAt);
            if (end !== null && end < start) throw new Error('异地结束时间不能早于开始时间');
            return { start, end };
        })
    };
}

function unionLength(ranges, inclusive = false) {
    const sorted = ranges.filter(([start, end]) => end >= start).sort((a, b) => a[0] - b[0]);
    let total = 0;
    let current;
    for (const [start, end] of sorted) {
        if (!current) current = [start, end];
        else if (start <= current[1] + (inclusive ? 1 : 0)) current[1] = Math.max(current[1], end);
        else {
            total += current[1] - current[0] + (inclusive ? 1 : 0);
            current = [start, end];
        }
    }
    if (current) total += current[1] - current[0] + (inclusive ? 1 : 0);
    return total;
}

export function meetingDayCount(meetings, today, now = new Date()) {
    const cutoff = parseDay(today);
    return unionLength(meetings.filter(({ startAt }) => startAt == null || startAt <= now.getTime())
        .map(({ start, end }) => [start, Math.min(end, cutoff)]), true);
}

export function meetingYears(meetings, today) {
    const years = new Set([Number(today.slice(0, 4))]);
    for (const { start, end } of meetings) {
        const first = Number(formatDay(start).slice(0, 4));
        const last = Number(formatDay(end).slice(0, 4));
        for (let year = first; year <= last; year++) years.add(year);
    }
    return [...years].sort((a, b) => b - a);
}

export function distanceDuration(periods, now = new Date()) {
    if (!periods.length) return null;
    const cutoff = now.getTime();
    const milliseconds = unionLength(periods.map(({ start, end }) => [start, Math.min(end ?? cutoff, cutoff)]));
    const seconds = Math.floor(milliseconds / 1000);
    const started = periods.some(({ start }) => start <= cutoff);
    return {
        // The start is day 1; every complete 24 hours starts the next day.
        days: started ? Math.floor(seconds / 86400) + 1 : 0,
        hours: Math.floor(seconds / 3600) % 24,
        minutes: Math.floor(seconds / 60) % 60,
        seconds: seconds % 60,
        milliseconds
    };
}

export function calendarDays(year, meetings, today, now = new Date()) {
    if (!Number.isInteger(year) || year < 100 || year > 9998) throw new Error('年份无效');
    const first = parseDay(`${year}-01-01`);
    const last = parseDay(`${year}-12-31`);
    const cutoff = parseDay(today);
    return Array.from({ length: last - first + 1 }, (_, index) => {
        const day = first + index;
        const records = meetings.filter(({ start, end }) => start <= day && end >= day);
        const met = day <= cutoff && records.some(({ startAt }) => startAt == null || startAt <= now.getTime());
        return {
            date: formatDay(day),
            state: records.length ? (met ? 'met' : 'planned') : (day <= cutoff ? 'empty' : 'future'),
            titles: [...new Set(records.map(({ title }) => title).filter(Boolean))],
            details: records.map(({ dateLabel, title }) => `${dateLabel}${title ? ` · ${title}` : ''}`)
        };
    });
}
