import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { _, intlLocale, language } from '../../i18n.js';

export const type = 'calendar';
export const label = 'Calendar';
export const stylesheet = 'widgets/calendar/stylesheet.css';
export const appIds = ['org.gnome.Calendar.desktop'];
export const defaultSize = 'small';

const CALENDAR_CELL_WIDTH = 24;
const CALENDAR_CELL_HEIGHT = 24;
const COMPACT_CALENDAR_CELL_HEIGHT = 23;
const WIDE_CALENDAR_MIN_WIDTH = 400;
const UPCOMING_DAYS = 14;
const UPCOMING_LIMIT = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const liveBodies = new Map();
let watchedSource = null;
let rerenderId = 0;

function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
};

function formatMonth(date) {
	const text = date.toLocaleDateString(intlLocale(), {
		month: 'long',
		year: 'numeric',
	}).replace(/\s*р\.$/, '');

	return capitalize(text);
};

function weekdayInitials(firstDay) {
	const formatter = new Intl.DateTimeFormat(intlLocale(), {weekday: 'narrow'});
	// 2023-01-01 was a Sunday.
	const sunday = new Date(2023, 0, 1);

	return [...Array(7).keys()].map(column => {
		const date = new Date(sunday);

		date.setDate(sunday.getDate() + (firstDay + column) % 7);
		return formatter.format(date).toUpperCase();
	});
};

function firstDayOfWeek(settings) {
	const setting = settings?.get_string('first-day-of-week') ?? 'auto';

	if (setting === 'monday') {
		return 1;
	};
	if (setting === 'sunday') {
		return 0;
	};

	return language() === 'uk' ? 1 : Shell.util_get_week_start();
};

// Read-only use of the top bar's event source: requesting our own range
// would move the calendar server's single shared range under the panel.
function shellEventSource() {
	return Main.panel?.statusArea?.dateMenu?._eventSource ?? null;
};

function scheduleRerender() {
	if (rerenderId) {
		return;
	};

	rerenderId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
		rerenderId = 0;
		for (const [body, context] of liveBodies) {
			body.destroy_all_children();
			build(body, context);
		};

		return GLib.SOURCE_REMOVE;
	});
};

function watchEventSource(source) {
	if (source === watchedSource) {
		return;
	};

	watchedSource?.disconnectObject?.(liveBodies);
	watchedSource = source;
	source?.connectObject?.('changed', () => scheduleRerender(), liveBodies);
};

export function cleanup() {
	watchedSource?.disconnectObject?.(liveBodies);
	watchedSource = null;
	liveBodies.clear();

	if (rerenderId) {
		GLib.source_remove(rerenderId);
		rerenderId = 0;
	};
};

function calendarCell(text, labelStyle, cellStyle, createLabel, cellHeight, dotColor = null) {
	const cellParams = {
		style_class: 'widget-calendar-cell',
		layout_manager: new Clutter.BinLayout(),
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
		x_expand: false,
		y_expand: false,
	};

	if (cellStyle) {
		cellParams.style = cellStyle;
	};

	const cell = new St.Widget(cellParams);
	const labelActor = createLabel(text, 'widget-calendar-day', labelStyle);

	labelActor.x_expand = false;
	labelActor.x_align = Clutter.ActorAlign.CENTER;
	labelActor.y_align = Clutter.ActorAlign.CENTER;
	cell.set_size(CALENDAR_CELL_WIDTH, cellHeight);
	cell.add_child(labelActor);

	if (dotColor) {
		cell.add_child(new St.Widget({
			style_class: 'widget-calendar-event-dot',
			style: `background-color: ${dotColor};`,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.END,
		}));
	};

	return cell;
};

function isAllDay(event) {
	const begin = event.date;

	return begin.getHours() === 0 && begin.getMinutes() === 0 &&
		(event.end - begin) % DAY_MS === 0 && event.end > begin;
};

function dayLabel(date, today) {
	const diff = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - today) / DAY_MS);

	if (diff <= 0) {
		return _('Today');
	};
	if (diff === 1) {
		return _('Tomorrow');
	};

	return date.toLocaleDateString(intlLocale(), {day: 'numeric', month: 'short'});
};

function eventTimeLabel(event, now, today) {
	const day = event.date < now ? now : event.date;
	const time = isAllDay(event)
		? _('All day')
		: event.date.toLocaleTimeString(intlLocale(), {hour: '2-digit', minute: '2-digit'});

	return `${dayLabel(day, today)} · ${time}`;
};

function upcomingEvents(source, now, today) {
	const end = new Date(today.getTime() + UPCOMING_DAYS * DAY_MS);

	return source.getEvents(today, end)
		.filter(event => event.end > now)
		.slice(0, UPCOMING_LIMIT);
};

function buildEventList(source, theme, createLabel) {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const list = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-calendar-events',
		x_expand: true,
		y_align: Clutter.ActorAlign.CENTER,
	});
	const events = upcomingEvents(source, now, today);

	if (events.length === 0) {
		list.add_child(createLabel(_('No upcoming events'), 'widget-calendar-event-empty', `color: ${theme.muted};`));
		return list;
	};

	for (const event of events) {
		const item = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			style_class: 'widget-calendar-event',
			style: `border-color: ${theme.accent};`,
		});

		item.add_child(createLabel(eventTimeLabel(event, now, today), 'widget-calendar-event-time', `color: ${theme.muted};`));
		item.add_child(createLabel(event.summary || _('Untitled event'), 'widget-calendar-event-title', `color: ${theme.text};`));
		list.add_child(item);
	};

	return list;
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text}; padding: 12px 15px;`;
};

function buildMonth(context, source, firstDay) {
	const {createLabel, theme} = context;
	const now = new Date();
	const year = now.getFullYear();
	const month = now.getMonth();
	const today = now.getDate();
	const first = new Date(year, month, 1);
	const days = new Date(year, month + 1, 0).getDate();
	const start = (first.getDay() - firstDay + 7) % 7;
	const weekCount = Math.ceil((start + days) / 7);
	const compact = weekCount === 6;
	const cellHeight = compact ? COMPACT_CALENDAR_CELL_HEIGHT : CALENDAR_CELL_HEIGHT;
	const monthLabel = createLabel(
		formatMonth(now),
		'widget-calendar-month',
		`color: ${theme.text};`);
	const grid = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: compact ? 'widget-calendar-grid widget-calendar-grid-compact' : 'widget-calendar-grid',
		x_align: Clutter.ActorAlign.CENTER,
	});
	const content = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-calendar-content',
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});
	const weekdayRow = new St.BoxLayout({style_class: 'widget-calendar-row'});
	const isWeekendColumn = column => [0, 6].includes((firstDay + column) % 7);
	let day = 1;

	monthLabel.x_expand = false;
	content.add_child(monthLabel);
	for (const [column, weekday] of weekdayInitials(firstDay).entries()) {
		const color = isWeekendColumn(column) ? theme.muted : theme.text;

		weekdayRow.add_child(calendarCell(weekday, `color: ${color}; font-weight: 700;`, null, createLabel, cellHeight));
	};
	grid.add_child(weekdayRow);

	for (let rowIndex = 0; rowIndex < weekCount; rowIndex++) {
		const row = new St.BoxLayout({style_class: 'widget-calendar-row'});

		for (let column = 0; column < 7; column++) {
			if ((rowIndex === 0 && column < start) || day > days) {
				row.add_child(calendarCell('', '', null, createLabel, cellHeight));
				continue;
			};

			const isToday = day === today;
			const labelStyle = isToday
				? 'color: #ffffff; font-weight: 800;'
				: `color: ${isWeekendColumn(column) ? theme.muted : theme.text};`;
			const cellStyle = isToday
				? `background-color: ${theme.accent}; border-radius: 999px;`
				: null;
			const hasEvents = source?.hasEvents(new Date(year, month, day)) ?? false;
			const dotColor = hasEvents ? (isToday ? '#ffffff' : theme.accent) : null;

			row.add_child(calendarCell(String(day), labelStyle, cellStyle, createLabel, cellHeight, dotColor));
			day++;
		};

		grid.add_child(row);
	};

	content.add_child(grid);
	return content;
};

function build(body, context) {
	const {settings, widget, sizeForWidget} = context;
	const showEvents = settings?.get_boolean('calendar-show-events') ?? true;
	const source = showEvents ? shellEventSource() : null;
	const [width] = sizeForWidget(widget);
	const month = buildMonth(context, source, firstDayOfWeek(settings));

	if (showEvents) {
		watchEventSource(source);
	};

	body.add_child(new St.Widget({y_expand: true}));

	if (source && width >= WIDE_CALENDAR_MIN_WIDTH) {
		const row = new St.BoxLayout({
			style_class: 'widget-calendar-wide',
			x_expand: true,
		});

		row.add_child(month);
		row.add_child(buildEventList(source, context.theme, context.createLabel));
		body.add_child(row);
	} else {
		body.add_child(month);
	};

	body.add_child(new St.Widget({y_expand: true}));
};

export function render(context) {
	const {body} = context;

	if (!liveBodies.has(body)) {
		body.connect('destroy', () => liveBodies.delete(body));
	};

	liveBodies.set(body, context);
	build(body, context);
};
