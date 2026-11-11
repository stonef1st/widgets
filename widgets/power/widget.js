import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { _, format, intlLocale } from '../../i18n.js';
import { warn } from '../../logger.js';
import { createSession, fetchJson } from '../../net.js';
import { DATA_URL, PROVIDERS, SLOTS_PER_DAY, groupLabel, kyivNow, midnightUnix, scheduleStatus } from '../../outages.js';
import { ADAPTERS, matchAddress } from '../../planned.js';

export const type = 'power';
export const label = 'Power Outages';
export const stylesheet = 'widgets/power/stylesheet.css';
export const defaultSize = 'small';
export const optional = true;

const FETCH_SECONDS = 10 * 60;
const RENDER_SECONDS = 60;
const SLOT_COLORS = {
	on: '#33d17a',
	off: '#e01b24',
	maybe: '#f6d32d',
	unknown: null,
	// Address outages announced by the oblenergo, on top of the queue schedule.
	planned: '#c061cb',
	emergency: '#ff7800',
};
// Planned works change rarely and their page is heavy; emergencies follow FETCH_SECONDS.
const PLANNED_FETCH_MS = 30 * 60 * 1000;

const state = {
	session: null,
	cancellable: null,
	fetchId: 0,
	renderId: 0,
	fetching: false,
	provider: null,
	data: null,
	error: false,
	settings: null,
	// Address outages: raw events per kind for eventsArea ('provider|area').
	eventsArea: null,
	events: {planned: null, emergency: null},
	plannedAt: 0,
};
const liveBodies = new Map();
const listeners = new Set();

// How long before an outage the top bar item appears, and turns yellow.
const PANEL_AHEAD_MINUTES = 120;
const PANEL_SOON_MINUTES = 30;

function formatTime(date) {
	return date.toLocaleTimeString(intlLocale(), {hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv'});
};

function providerName(provider) {
	const entry = PROVIDERS.find(([id]) => id === provider);

	return entry ? _(entry[1]) : provider;
};

function isCancelled(error) {
	return error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
};

async function fetchSchedule(provider) {
	try {
		const data = await fetchJson(state.session, format(DATA_URL, provider), state.cancellable);

		state.provider = provider;
		state.data = data;
		state.error = false;
	} catch (error) {
		if (!isCancelled(error)) {
			warn('outages-fetch', `Could not fetch outage schedule: ${error.message}`);
			state.error = true;
		};
	};
};

async function fetchEvents(provider) {
	const adapter = ADAPTERS[provider];
	const area = state.settings?.get_string('outage-area') ?? '';
	const areaKey = `${provider}|${area}`;

	if (!adapter || !area) {
		return;
	};

	if (state.eventsArea !== areaKey) {
		state.eventsArea = areaKey;
		state.events = {planned: null, emergency: null};
		state.plannedAt = 0;
	};

	const kinds = Date.now() - state.plannedAt >= PLANNED_FETCH_MS ? ['emergency', 'planned'] : ['emergency'];

	await Promise.all(kinds.map(async kind => {
		try {
			state.events[kind] = await adapter.fetch(state.session, area, kind, state.cancellable);

			if (kind === 'planned') {
				state.plannedAt = Date.now();
			};
		} catch (error) {
			if (!isCancelled(error)) {
				warn(`outages-${kind}`, `Could not fetch ${kind} outages from ${adapter.source}: ${error.message}`);
			};
		};
	}));
};

async function fetchData() {
	const provider = state.settings?.get_string('outage-provider') ?? '';

	if (!provider || state.fetching) {
		return;
	};

	state.fetching = true;
	try {
		await Promise.all([fetchSchedule(provider), fetchEvents(provider)]);
	} finally {
		state.fetching = false;
	};

	rerender();
};

// Address outages that are on or ahead, sorted by start. Empty until the
// area and the address are set.
function addressEvents(settings) {
	const get = key => settings?.get_string(key) ?? '';
	const areaKey = `${get('outage-provider')}|${get('outage-area')}`;

	if (state.eventsArea !== areaKey) {
		return [];
	};

	const now = Date.now();
	const events = [...(state.events.planned ?? []), ...(state.events.emergency ?? [])];

	return matchAddress(events, {city: get('outage-city'), street: get('outage-street'), house: get('outage-house')})
		.filter(event => event.end > now);
};

function splitEvents(events) {
	const now = Date.now();

	return {
		active: events.find(event => event.start <= now) ?? null,
		upcoming: events.find(event => event.start > now) ?? null,
	};
};

function formatDay(date) {
	return date.toLocaleDateString(intlLocale(), {day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv'});
};

function kindLabel(event) {
	return event.kind === 'planned' ? _('Planned') : _('Emergency');
};

// "Планове · 11:20–20:20", with dates when not today.
function eventLabel(event) {
	const today = formatDay(new Date());
	const startDay = formatDay(event.start);
	const endDay = formatDay(event.end);
	const start = `${startDay === today ? '' : `${startDay} `}${formatTime(event.start)}`;
	const end = event.endKnown ? `${endDay === startDay ? '' : `${endDay} `}${formatTime(event.end)}` : '?';

	return `${kindLabel(event)} · ${start}–${end}`;
};

// Paints address outages over the queue slots of one day. Queue outages
// stay on top, so the strip still shows when the queue is off.
function withEvents(slots, events, dayUnix) {
	const result = slots ? [...slots] : new Array(SLOTS_PER_DAY).fill('unknown');

	for (const event of events) {
		for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
			const from = (dayUnix + slot * 30 * 60) * 1000;

			if (result[slot] !== 'off' && event.start.getTime() < from + 30 * 60 * 1000 && event.end.getTime() > from) {
				result[slot] = event.kind;
			};
		};
	};

	return result;
};

function start(settings) {
	state.settings = settings;

	if (state.fetchId) {
		return;
	};

	state.session = createSession();
	state.cancellable = new Gio.Cancellable();
	state.fetchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FETCH_SECONDS, () => {
		fetchData();
		return GLib.SOURCE_CONTINUE;
	});
	// The schedule moves with the clock even without new data.
	state.renderId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RENDER_SECONDS, () => {
		if (liveBodies.size === 0 && listeners.size === 0) {
			stop();
			return GLib.SOURCE_REMOVE;
		};

		rerender();
		return GLib.SOURCE_CONTINUE;
	});
	fetchData();
};

function stop() {
	for (const key of ['fetchId', 'renderId']) {
		if (state[key]) {
			GLib.source_remove(state[key]);
			state[key] = 0;
		};
	};

	state.cancellable?.cancel();
	state.cancellable = null;
	state.session?.abort();
	state.session = null;
	state.fetching = false;
};

export function cleanup() {
	stop();
	liveBodies.clear();
	listeners.clear();
	state.settings = null;
};

function rerender() {
	for (const [body, context] of liveBodies) {
		body.destroy_all_children();
		build(body, context);
	};

	const summary = panelSummary();

	for (const listener of listeners) {
		listener(summary);
	};
};

function slotClock(slot) {
	return `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;
};

// "08:00–12:00, 16:00–18:00?" where the question mark is a possible outage.
function outageRanges(slots) {
	const ranges = [];
	let start = null;

	for (let slot = 0; slot <= slots.length; slot++) {
		if (start !== null && slots[slot] !== slots[start]) {
			ranges.push(`${slotClock(start)}–${slotClock(slot)}${slots[start] === 'maybe' ? '?' : ''}`);
			start = null;
		};

		if (start === null && ['off', 'maybe'].includes(slots[slot])) {
			start = slot;
		};
	};

	return ranges.join(', ') || _('none');
};

// null unless an outage is on or close. {text, color, lines}
function panelSummary() {
	const provider = state.settings?.get_string('outage-provider') ?? '';
	const group = state.settings?.get_string('outage-group') ?? '';
	const data = state.provider === provider ? state.data : null;
	const status = provider && group && data ? scheduleStatus(data, group) : null;
	const events = addressEvents(state.settings);
	const {active, upcoming} = splitEvents(events);

	if (!status?.today && events.length === 0) {
		return null;
	};

	const lines = events.slice(0, 3).map(eventLabel);

	if (status?.today) {
		// The queue status line would claim power during an address outage.
		if (!active) {
			lines.push(`${statusTitle(status.current)} · ${nextLabel(status)}`);
		};

		lines.push(
			`${_('Today')}: ${outageRanges(status.today)}`,
			`${_('Tomorrow')}: ${status.tomorrow ? outageRanges(status.tomorrow) : _('no schedule')}`,
		);
	};

	if (active) {
		return {
			text: active.endKnown ? format(_('until %s'), formatTime(active.end)) : kindLabel(active),
			color: SLOT_COLORS[active.kind],
			lines,
		};
	};

	const {current, next} = status ?? {};

	if (current === 'off' || current === 'maybe') {
		return {
			text: next ? format(_('until %s'), formatTime(next.at)) : statusTitle(current),
			color: SLOT_COLORS[current],
			lines,
		};
	};

	const minutes = current === 'on' && ['off', 'maybe'].includes(next?.state) ? (next.at - Date.now()) / 60000 : Infinity;
	const eventMinutes = upcoming ? (upcoming.start - Date.now()) / 60000 : Infinity;

	if (eventMinutes <= PANEL_AHEAD_MINUTES && eventMinutes <= minutes) {
		return {
			text: formatTime(upcoming.start),
			color: eventMinutes <= PANEL_SOON_MINUTES ? SLOT_COLORS.maybe : null,
			lines,
		};
	};

	if (minutes > PANEL_AHEAD_MINUTES) {
		return null;
	};

	return {
		text: `${next.state === 'maybe' ? '~' : ''}${formatTime(next.at)}`,
		color: next.state === 'off' && minutes <= PANEL_SOON_MINUTES ? SLOT_COLORS.maybe : null,
		lines,
	};
};

// Keeps fetching without a widget on the desktop. The listener gets the
// summary now and after every refresh. Returns the unsubscribe.
export function subscribe(settings, listener) {
	listeners.add(listener);
	state.settings = settings;
	listener(panelSummary());
	start(settings);

	return () => listeners.delete(listener);
};

export function refresh() {
	if (state.fetchId) {
		fetchData();
	};
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

function statusTitle(current) {
	switch (current) {
		case 'on':
			return _('Power on');
		case 'off':
			return _('Power off');
		case 'maybe':
			return _('Possible outage');
		default:
			return _('No data');
	};
};

function nextLabel(status) {
	if (!status.next) {
		return status.tomorrow ? _('No changes until tomorrow night') : _('No changes until midnight');
	};

	const time = formatTime(status.next.at);

	switch (status.next.state) {
		case 'off':
			return format(_('Outage at %s'), time);
		case 'maybe':
			return format(_('Possible outage at %s'), time);
		case 'on':
			return format(_('Power back at %s'), time);
		default:
			return format(_('Schedule ends at %s'), time);
	};
};

const HOURS_PER_DAY = 24;
const SCALE_HOURS = [0, 6, 12, 18, 24];

// Whole-pixel bar width, so every hour bar is exactly the same size. The gap
// is picked per width to leave the smallest remainder, which is then split
// evenly on both sides.
function stripGeometry(width) {
	let best = null;

	for (const gap of [2, 1, 3]) {
		const bar = Math.floor((width - gap * (HOURS_PER_DAY - 1)) / HOURS_PER_DAY);

		if (bar < 1) {
			continue;
		};

		const used = bar * HOURS_PER_DAY + gap * (HOURS_PER_DAY - 1);

		if (!best || width - used < best.rest) {
			best = {bar, gap, rest: width - used};
		};
	};

	best ??= {bar: 1, gap: 0, rest: Math.max(0, width - HOURS_PER_DAY)};
	best.offset = Math.floor(best.rest / 2);
	return best;
};

const HourStripLayout = GObject.registerClass(
	class HourStripLayout extends Clutter.LayoutManager {
		vfunc_get_preferred_width(_container, _forHeight) {
			return [HOURS_PER_DAY, HOURS_PER_DAY * 4];
		}

		vfunc_get_preferred_height(container, forWidth) {
			let [min, nat] = [0, 0];

			for (const child of container) {
				const [childMin, childNat] = child.get_preferred_height(-1);

				min = Math.max(min, childMin);
				nat = Math.max(nat, childNat);
			};

			return [min, nat];
		}

		vfunc_allocate(container, box) {
			const {bar, gap, offset} = stripGeometry(Math.floor(box.get_width()));
			const children = [...container];

			children.forEach((child, index) => {
				const childBox = new Clutter.ActorBox();
				const x = box.x1 + offset + index * (bar + gap);

				childBox.set_origin(x, box.y1);
				childBox.set_size(bar, box.get_height());
				child.allocate(childBox);
			});
		}
	});

// Places the hour labels under the matching gaps of the strip above.
const HourScaleLayout = GObject.registerClass(
	class HourScaleLayout extends HourStripLayout {
		vfunc_allocate(container, box) {
			const {bar, gap, offset} = stripGeometry(Math.floor(box.get_width()));
			const step = bar + gap;
			const end = offset + step * HOURS_PER_DAY - gap;

			[...container].forEach((child, index) => {
				const hour = SCALE_HOURS[index];
				const [, width] = child.get_preferred_width(-1);
				const [, height] = child.get_preferred_height(width);
				let x = offset + hour * step - gap / 2 - width / 2;

				if (hour === 0) {
					x = offset;
				} else if (hour === HOURS_PER_DAY) {
					x = end - width;
				};

				const childBox = new Clutter.ActorBox();

				childBox.set_origin(Math.round(box.x1 + x), box.y1);
				childBox.set_size(width, height);
				child.allocate(childBox);
			});
		}
	});

function buildStrip(slots, currentSlot, theme) {
	const strip = new St.Widget({
		style_class: 'widget-power-strip',
		layout_manager: new HourStripLayout(),
		x_expand: true,
	});
	const currentHour = Math.floor(currentSlot / 2);

	// Each hour bar holds two half-hour slots, so half-hour outages stay visible.
	for (let hour = 0; hour < SLOTS_PER_DAY / 2; hour++) {
		const current = hour === currentHour;
		const hourBar = new St.BoxLayout({
			style_class: current ? 'widget-power-hour widget-power-hour-current' : 'widget-power-hour',
			style: current ? `border-color: ${theme.text};` : '',
		});

		for (const [half, slot] of [['first', hour * 2], ['second', hour * 2 + 1]]) {
			hourBar.add_child(new St.Widget({
				style_class: `widget-power-slot widget-power-slot-${half}`,
				style: `background-color: ${SLOT_COLORS[slots[slot]] ?? theme.track};`,
				x_expand: true,
				y_expand: true,
			}));
		};

		strip.add_child(hourBar);
	};

	return strip;
};

function buildScale(createLabel, theme) {
	const scale = new St.Widget({
		style_class: 'widget-power-scale',
		layout_manager: new HourScaleLayout(),
		x_expand: true,
	});

	for (const hour of SCALE_HOURS) {
		scale.add_child(createLabel(String(hour), 'widget-power-scale-label', `color: ${theme.muted};`));
	};

	return scale;
};

function build(body, {createLabel, theme, settings}) {
	const provider = settings?.get_string('outage-provider') ?? '';
	const group = settings?.get_string('outage-group') ?? '';
	const header = new St.BoxLayout({style_class: 'widget-power-header'});
	const data = state.provider === provider ? state.data : null;
	const status = provider && group && data ? scheduleStatus(data, group) : null;
	const events = addressEvents(settings);
	const {active, upcoming} = splitEvents(events);
	const iconState = active?.kind ?? status?.current;
	const icon = new St.Icon({
		icon_name: 'ac-adapter-symbolic',
		style_class: 'widget-power-icon',
		style: `color: ${iconState ? SLOT_COLORS[iconState] ?? theme.muted : theme.muted};`,
	});
	const title = provider && group
		? format(_('Group %s'), groupLabel(group))
		: _('Power Outages');
	const headerLabel = createLabel(title, 'widget-power-group', `color: ${theme.muted};`);

	headerLabel.y_align = Clutter.ActorAlign.CENTER;
	header.add_child(icon);
	header.add_child(headerLabel);
	body.add_child(header);
	body.add_child(new St.Widget({y_expand: true}));

	if (!provider || !group) {
		body.add_child(createLabel(_('Choose your group'), 'widget-power-title', `color: ${theme.text};`));
		body.add_child(createLabel(_('Open extension settings'), 'widget-power-detail', `color: ${theme.muted};`));
		return;
	};

	if (!data) {
		body.add_child(createLabel(state.error ? _('No data') : _('Loading…'), 'widget-power-title', `color: ${theme.text};`));
		body.add_child(createLabel(providerName(provider), 'widget-power-detail', `color: ${theme.muted};`));
		return;
	};

	const todayUnix = midnightUnix(kyivNow());
	const todayEnd = (todayUnix + 24 * 3600) * 1000;
	const eventsToday = events.filter(event => event.start.getTime() < todayEnd);

	if (active) {
		body.add_child(createLabel(statusTitle('off'), 'widget-power-title', `color: ${theme.text};`));
		body.add_child(createLabel(active.endKnown
			? format(_('%s until %s'), kindLabel(active), formatTime(active.end))
			: kindLabel(active), 'widget-power-detail', `color: ${theme.muted};`));
	} else if (status.today) {
		body.add_child(createLabel(statusTitle(status.current), 'widget-power-title', `color: ${theme.text};`));
		body.add_child(createLabel(nextLabel(status), 'widget-power-detail', `color: ${theme.muted};`));
	} else {
		body.add_child(createLabel(_('No schedule today'), 'widget-power-title', `color: ${theme.text};`));
		if (status.updated) {
			body.add_child(createLabel(format(_('Last schedule: %s'), status.updated), 'widget-power-detail', `color: ${theme.muted};`));
		};
	};

	if (upcoming) {
		body.add_child(createLabel(eventLabel(upcoming), 'widget-power-detail', `color: ${SLOT_COLORS[upcoming.kind]};`));
	};

	if (status.today || eventsToday.length > 0) {
		body.add_child(buildStrip(withEvents(status.today, eventsToday, todayUnix), status.slot, theme));
		body.add_child(buildScale(createLabel, theme));
	};
};

export function render(context) {
	const {body, settings} = context;

	if (!liveBodies.has(body)) {
		body.connect('destroy', () => liveBodies.delete(body));
	};

	liveBodies.set(body, context);
	build(body, context);

	if (state.fetchId && (settings?.get_string('outage-provider') ?? '') !== state.provider) {
		state.settings = settings;
		fetchData();
	};
	start(settings);
};
