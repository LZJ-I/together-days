import { init, use } from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import { CalendarComponent, TooltipComponent, VisualMapComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

use([HeatmapChart, CalendarComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

const states = { empty: 0, met: 1, future: 2, planned: 3 };
const colors = ['#eadfe8', '#c56896', '#f6eff5', '#e8c7dc'];
const descriptions = { empty: '尚未记录见面', met: '这一天，我们见面了', future: '未来的日子，慢慢写', planned: '计划见面的日子' };

export function createCalendar(element, onSelect) {
    const chart = init(element, null, { renderer: 'svg' });
    let dayLookup = new Map();
    chart.on('click', (event) => {
        const day = dayLookup.get(event.value?.[0]);
        if (day) onSelect(day);
    });
    return {
        render(year, days) {
            dayLookup = new Map(days.map((day) => [day.date, day]));
            chart.setOption({
                animation: false,
                textStyle: { fontFamily: 'system-ui, sans-serif' },
                tooltip: {
                    trigger: 'item', confine: true, backgroundColor: '#fffafd', borderColor: '#ead3e2',
                    textStyle: { color: '#6b405c', fontSize: 12 },
                    formatter(event) {
                        const day = dayLookup.get(event.value?.[0]);
                        const tooltip = document.createElement('div');
                        if (day) {
                            tooltip.style.whiteSpace = 'pre-wrap';
                            tooltip.textContent = `${day.date}\n${descriptions[day.state]}${day.details.length ? `\n${day.details.join('\n')}` : ''}`;
                        }
                        return tooltip;
                    }
                },
                visualMap: {
                    show: false, type: 'piecewise', dimension: 1,
                    pieces: colors.map((color, value) => ({ value, color }))
                },
                calendar: {
                    range: String(year), left: 30, right: 8, top: 28, cellSize: ['auto', 16],
                    orient: 'horizontal', splitLine: { show: false },
                    itemStyle: { color: colors[0], borderColor: '#fffafd', borderWidth: 3 },
                    yearLabel: { show: false },
                    dayLabel: { firstDay: 1, nameMap: ['日', '一', '二', '三', '四', '五', '六'], color: '#9a8396', fontSize: 10, margin: 8 },
                    monthLabel: { nameMap: 'ZH', color: '#92768c', fontSize: 10, margin: 9 }
                },
                series: [{
                    type: 'heatmap', coordinateSystem: 'calendar',
                    data: days.map((day) => ({
                        value: [day.date, states[day.state]],
                        itemStyle: day.state === 'planned' ? { borderColor: '#d3a4c1', borderWidth: 2 } : undefined
                    })),
                    itemStyle: { borderColor: '#fffafd', borderWidth: 3 },
                    emphasis: { itemStyle: { borderColor: '#9b4a76', borderWidth: 2 } }
                }]
            }, { notMerge: true });
        },
        resize: () => chart.resize(),
        select(date) {
            chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
            const index = [...dayLookup.keys()].indexOf(date);
            if (index >= 0) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: index });
        }
    };
}
