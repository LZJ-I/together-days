import { calendarDays, distanceDuration, meetingDayCount, meetingYears, normalizeStory, parseDay, todayInZone } from './relationship-data.mjs?v=3';

const stateLabels = {
    empty: '尚未记录见面', met: '这一天，我们见面了',
    future: '未来的日子，慢慢写', planned: '计划见面的日子'
};

function setText(id, value) {
    const element = document.getElementById(id);
    const text = String(value);
    if (element.textContent !== text) element.textContent = text;
}

// The future CMS only needs to edit this JSON; presentation and statistics stay here.
export async function loadRelationshipData(url) {
    const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`无法读取见面记录 (${response.status})`);
    return normalizeStory(await response.json());
}

export async function mountRelationship(couple) {
    setText('story-name1', couple.name1);
    setText('story-name2', couple.name2);
    setText('story-location1', '…');
    setText('story-location2', '…');
    const error = document.getElementById('story-error');
    let story;
    try {
        story = await loadRelationshipData(couple.relationshipData);
    } catch (cause) {
        error.hidden = false;
        error.textContent = '我们的记录暂时没有加载成功，稍后刷新再试。';
        setText('distance-clock', '想念一直都在');
        setText('calendar-summary', '见面记录暂时无法读取');
        console.error('Relationship data:', cause);
        return;
    }

    setText('story-location1', story.locations.person1);
    setText('story-location2', story.locations.person2);
    const distance = document.getElementById('story-distance');
    distance.hidden = story.distanceKm === null;
    if (story.distanceKm !== null) {
        distance.textContent = `${story.distanceKm} km`;
        distance.setAttribute('aria-label', `两地相距 ${story.distanceKm} 千米`);
    }
    const firstPeriod = [...story.periods].sort((a, b) => a.start - b.start)[0];
    if (firstPeriod) {
        const parts = new Intl.DateTimeFormat('zh-CN', {
            timeZone: story.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(new Date(firstPeriod.start));
        const part = (type) => parts.find((item) => item.type === type).value;
        setText('distance-since', `始于 ${part('year')}.${part('month')}.${part('day')} ${part('hour')}:${part('minute')}`);
    } else {
        setText('distance-clock', '等我们记下异地的第一天');
    }

    const yearSelect = document.getElementById('meeting-year');
    const currentYearButton = document.getElementById('meeting-current-year');
    const scroll = document.querySelector('.story-calendar-scroll');
    const calendarElement = document.getElementById('meeting-calendar');
    let today = todayInZone(story.timeZone);
    let selectedDate = today;
    let days = [];
    let calendar;
    let lastMinute;

    function populateYears() {
        const years = meetingYears(story.meetings, today);
        const selected = yearSelect.value || today.slice(0, 4);
        yearSelect.replaceChildren();
        for (const year of years) {
            yearSelect.add(new Option(`${year} 年`, String(year)));
        }
        yearSelect.value = years.includes(Number(selected)) ? selected : today.slice(0, 4);
    }

    function selectDay(day, reveal = false) {
        if (!day) return;
        selectedDate = day.date;
        const detail = document.getElementById('calendar-day-detail');
        const heading = document.createElement('p');
        heading.className = `story-day-heading is-${day.state}`;
        heading.textContent = `${day.date.replaceAll('-', '.')} · ${stateLabels[day.state]}`;
        const note = document.createElement('p');
        note.className = 'story-day-note';
        note.textContent = day.details.join('\n') || (day.state === 'met' ? '平凡的一天，因为见到你而特别。' : '把相聚留在日历里，把期待留给下一次。');
        detail.replaceChildren(heading, note);
        calendar?.select(day.date);
        if (reveal) {
            const index = days.indexOf(day);
            scroll.scrollLeft = Math.max(0, index / days.length * calendarElement.clientWidth - scroll.clientWidth / 2);
        }
    }

    function renderCalendar() {
        const year = Number(yearSelect.value);
        days = calendarDays(year, story.meetings, today);
        const met = days.filter((day) => day.state === 'met').length;
        const planned = days.filter((day) => day.state === 'planned').length;
        setText('calendar-summary', `${year} 年 · 已见面 ${met} 天${planned ? ` · 计划 ${planned} 天` : ''}`);
        currentYearButton.disabled = year === Number(today.slice(0, 4));
        calendar?.render(year, days);
        const selected = days.find((day) => day.date === selectedDate)
            || days.find((day) => day.state === 'met') || days[0];
        selectDay(selected, true);
    }

    function renderRecords() {
        const container = document.getElementById('meeting-records');
        const cutoff = parseDay(today);
        const records = [...story.meetings].sort((a, b) => b.start - a.start || (b.startAt ?? 0) - (a.startAt ?? 0) || b.end - a.end);
        container.replaceChildren();
        document.getElementById('meeting-history').hidden = records.length === 0;
        setText('meeting-record-count', `${records.length} 条记录`);
        for (const record of records) {
            const row = document.createElement('article');
            row.className = 'story-record';
            const content = document.createElement('div');
            const date = document.createElement('p');
            date.className = 'story-record-date';
            date.textContent = record.dateLabel;
            const title = document.createElement('p');
            title.className = 'story-record-title';
            title.textContent = record.title || '一次见面';
            content.append(date, title);
            const status = document.createElement('span');
            status.className = 'story-record-status';
            const duration = record.end - record.start + 1;
            const now = Date.now();
            const planned = record.start > cutoff || (record.startAt !== null && record.startAt > now);
            const ongoing = record.endAt !== null ? record.endAt >= now : record.end >= cutoff;
            status.textContent = `${planned ? '计划见面' : ongoing ? '正在见面' : '已记录'} · ${duration} 天`;
            row.append(content, status);
            container.append(row);
        }
    }

    function update() {
        const now = new Date();
        const duration = distanceDuration(story.periods, now);
        if (duration) {
            setText('distance-days', duration.days);
            const pad = (value) => String(value).padStart(2, '0');
            setText('distance-clock', `${pad(duration.hours)} 时 ${pad(duration.minutes)} 分 ${pad(duration.seconds)} 秒`);
        }
        today = todayInZone(story.timeZone, now);
        const minute = Math.floor(now.getTime() / 60000);
        if (minute !== lastMinute) {
            lastMinute = minute;
            const count = meetingDayCount(story.meetings, today, now);
            setText('meeting-days', count);
            setText('meeting-message', count ? '每一次相聚，都值得被记住' : '下一次相聚，也值得期待');
            populateYears();
            renderCalendar();
            renderRecords();
        }
    }

    yearSelect.addEventListener('change', () => {
        selectedDate = Number(yearSelect.value) === Number(today.slice(0, 4)) ? today : `${yearSelect.value}-01-01`;
        renderCalendar();
    });
    currentYearButton.addEventListener('click', () => {
        yearSelect.value = today.slice(0, 4);
        selectedDate = today;
        renderCalendar();
    });
    scroll.addEventListener('keydown', (event) => {
        const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
        const index = days.findIndex((day) => day.date === selectedDate);
        let next;
        if (event.key in offsets) next = Math.max(0, Math.min(days.length - 1, index + offsets[event.key]));
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = days.length - 1;
        else return;
        event.preventDefault();
        selectDay(days[next], true);
    });
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) update(); });
    window.addEventListener('pagehide', (event) => { if (!event.persisted) clearInterval(timer); }, { once: true });

    try {
        const { createCalendar } = await import('./meeting-calendar.min.mjs?v=2');
        calendar = createCalendar(calendarElement, (day) => selectDay(day));
        renderCalendar();
        new ResizeObserver(() => calendar.resize()).observe(calendarElement);
    } catch (cause) {
        calendarElement.textContent = '日历暂时没有加载成功，仍可在下方查看见面记录。';
        calendarElement.classList.add('story-calendar-unavailable');
        console.error('Meeting calendar:', cause);
    }
}
