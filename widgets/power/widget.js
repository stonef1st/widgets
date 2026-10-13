import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { _, format, intlLocale } from '../../i18n.js';
import { warn } from '../../logger.js';
import { createSession, fetchJson } from '../../net.js';
import { DATA_URL, PROVIDERS, SLOTS_PER_DAY, groupLabel, scheduleStatus } from '../../outages.js';

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
};

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
};
const liveBodies = new Map();

function formatTime(date) {
	return date.toLocaleTimeString(intlLocale(), {hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv'});
};

function providerName(provider) {
	const entry = PROVIDERS.find(([id]) => id === provider);

	return entry ? _(entry[1]) : provider;
};

async function fetchData() {
	const provider = state.settings?.get_string('outage-provider') ?? '';

	if (!provider || state.fetching) {
		return;
	};

	state.fetching = true;
	try {
		const data = await fetchJson(state.session, format(DATA_URL, provider), state.cancellable);

		state.provider = provider;
		state.data = data;
		state.error = false;
	} catch (error) {
		if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
			warn('outages-fetch', `Could not fetch outage schedule: ${error.message}`);
			state.error = true;
		};
	} finally {
		state.fetching = false;
	};

	rerender();
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
		if (liveBodies.size === 0) {
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
	state.settings = null;
};

function rerender() {
	for (const [body, context] of liveBodies) {
		body.destroy_all_children();
		build(body, context);
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

function buildStrip(slots, currentSlot, theme) {
	const strip = new St.BoxLayout({
		style_class: 'widget-power-strip',
		x_expand: true,
	});

	for (let index = 0; index < SLOTS_PER_DAY; index++) {
		const color = SLOT_COLORS[slots[index]] ?? theme.border;
		const current = index === currentSlot;

		strip.add_child(new St.Widget({
			style_class: current ? 'widget-power-slot widget-power-slot-current' : 'widget-power-slot',
			style: `background-color: ${color};${current ? ` border-color: ${theme.text};` : ''}`,
			x_expand: true,
		}));
	};

	return strip;
};

function buildScale(createLabel, theme) {
	const scale = new St.BoxLayout({
		style_class: 'widget-power-scale',
		x_expand: true,
	});

	for (const hour of ['0', '6', '12', '18', '24']) {
		const labelActor = createLabel(hour, 'widget-power-scale-label', `color: ${theme.muted};`);

		labelActor.x_expand = true;
		labelActor.x_align = hour === '24' ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
		scale.add_child(labelActor);
	};

	return scale;
};

function build(body, {createLabel, theme, settings}) {
	const provider = settings?.get_string('outage-provider') ?? '';
	const group = settings?.get_string('outage-group') ?? '';
	const header = new St.BoxLayout({style_class: 'widget-power-header'});
	const data = state.provider === provider ? state.data : null;
	const status = provider && group && data ? scheduleStatus(data, group) : null;
	const icon = new St.Icon({
		icon_name: 'ac-adapter-symbolic',
		style_class: 'widget-power-icon',
		style: `color: ${status?.current ? SLOT_COLORS[status.current] ?? theme.muted : theme.muted};`,
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

	if (!status.today) {
		body.add_child(createLabel(_('No schedule today'), 'widget-power-title', `color: ${theme.text};`));
		if (status.updated) {
			body.add_child(createLabel(format(_('Last schedule: %s'), status.updated), 'widget-power-detail', `color: ${theme.muted};`));
		};
		return;
	};

	body.add_child(createLabel(statusTitle(status.current), 'widget-power-title', `color: ${theme.text};`));
	body.add_child(createLabel(nextLabel(status), 'widget-power-detail', `color: ${theme.muted};`));
	body.add_child(buildStrip(status.today, status.slot, theme));
	body.add_child(buildScale(createLabel, theme));
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
