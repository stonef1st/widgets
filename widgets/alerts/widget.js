import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ALERTS_URL, REGIONS_URL, alertStatus, indexRegions, relevantRegionIds } from '../../alerts.js';
import { _, format, intlLocale } from '../../i18n.js';
import { warn } from '../../logger.js';
import { createSession, fetchJson } from '../../net.js';

export const type = 'alerts';
export const label = 'Air Raid Alerts';
export const stylesheet = 'widgets/alerts/stylesheet.css';
export const defaultSize = 'small';
export const optional = true;

const POLL_SECONDS = 30;
const ALERT_BACKGROUND = '#c01c28';
const ALERT_BORDER = '#a51d2d';

const TYPE_LABELS = {
	AIR: 'Air raid alert',
	ARTILLERY: 'Artillery shelling',
	URBAN_FIGHTS: 'Urban fighting',
	CHEMICAL: 'Chemical threat',
	NUCLEAR: 'Nuclear threat',
};

const state = {
	session: null,
	cancellable: null,
	pollId: 0,
	fetching: false,
	regions: null,
	regionId: null,
	regionIds: null,
	status: null,
	error: false,
	clearedAt: null,
	settings: null,
};
const liveBodies = new Map();

function typeLabel(alertType) {
	return _(TYPE_LABELS[alertType] ?? 'Air raid alert');
};

function formatTime(date) {
	return date.toLocaleTimeString(intlLocale(), {hour: '2-digit', minute: '2-digit'});
};

function formatDuration(ms) {
	const minutes = Math.max(0, Math.floor(ms / 60000));
	const hours = Math.floor(minutes / 60);

	return hours > 0
		? format(_('%s h %s min'), hours, minutes % 60)
		: format(_('%s min'), minutes);
};

function notify(status, regionName) {
	if (!state.settings?.get_boolean('alerts-notify')) {
		return;
	};

	const title = status.active
		? status.types.map(typeLabel).join(', ')
		: _('All clear');

	Main.notify(title, regionName);
};

async function ensureRegions(regionId) {
	if (!state.regions) {
		state.regions = indexRegions(await fetchJson(state.session, REGIONS_URL, state.cancellable));
	};

	if (state.regionId !== regionId) {
		state.regionId = regionId;
		state.regionIds = relevantRegionIds(state.regions, regionId);
		state.status = null;
		state.clearedAt = null;
	};
};

async function poll() {
	const regionId = state.settings?.get_string('alerts-region-id') ?? '';

	if (!regionId || state.fetching) {
		rerender();
		return;
	};

	state.fetching = true;
	try {
		await ensureRegions(regionId);

		const alerts = await fetchJson(state.session, ALERTS_URL, state.cancellable);
		const previous = state.status;
		const status = alertStatus(alerts, state.regionIds);

		if (previous && previous.active !== status.active) {
			if (!status.active) {
				state.clearedAt = new Date();
			};
			notify(status, state.settings.get_string('alerts-region-name'));
		};

		state.status = status;
		state.error = false;
	} catch (error) {
		if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
			warn('alerts-fetch', `Could not fetch air raid alerts: ${error.message}`);
			state.error = true;
		};
	} finally {
		state.fetching = false;
	};

	rerender();
};

function startPolling(settings) {
	state.settings = settings;

	if (state.pollId) {
		return;
	};

	state.session = createSession();
	state.cancellable = new Gio.Cancellable();
	state.pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
		if (liveBodies.size === 0) {
			stopPolling();
			return GLib.SOURCE_REMOVE;
		};

		poll();
		return GLib.SOURCE_CONTINUE;
	});
	poll();
};

function stopPolling() {
	if (state.pollId) {
		GLib.source_remove(state.pollId);
		state.pollId = 0;
	};

	state.cancellable?.cancel();
	state.cancellable = null;
	state.session?.abort();
	state.session = null;
	state.fetching = false;
};

export function cleanup() {
	stopPolling();
	liveBodies.clear();
	state.status = null;
	state.regionId = null;
	state.clearedAt = null;
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

function applyCardStyle(body, theme, active) {
	const card = body.get_parent();

	card?.set_style(active
		? `background-color: ${ALERT_BACKGROUND}; border-color: ${ALERT_BORDER}; color: #ffffff;`
		: style(theme));
};

function build(body, {createLabel, theme, settings}) {
	const regionId = settings?.get_string('alerts-region-id') ?? '';
	const regionName = settings?.get_string('alerts-region-name') || _('Region not set');
	const status = state.status;
	const active = Boolean(regionId && status?.active);
	const text = active ? '#ffffff' : theme.text;
	const muted = active ? 'rgba(255, 255, 255, 0.82)' : theme.muted;

	applyCardStyle(body, theme, active);

	const header = new St.BoxLayout({style_class: 'widget-alerts-header'});
	const icon = new St.Icon({
		icon_name: active ? 'dialog-warning-symbolic' : 'security-high-symbolic',
		style_class: 'widget-alerts-icon',
		style: `color: ${active ? '#ffffff' : theme.accent};`,
	});
	const regionLabel = createLabel(regionName, 'widget-alerts-region', `color: ${muted};`);

	regionLabel.y_align = Clutter.ActorAlign.CENTER;
	header.add_child(icon);
	header.add_child(regionLabel);
	body.add_child(header);
	body.add_child(new St.Widget({y_expand: true}));

	let title;
	const details = [];

	if (!regionId) {
		title = _('Choose a region');
		details.push(_('Open extension settings'));
	} else if (!status) {
		title = state.error ? _('No data') : _('Loading…');
		if (state.error) {
			details.push(_('Alert service unavailable'));
		};
	} else if (active) {
		title = status.types.map(typeLabel).join(', ');
		if (status.since) {
			details.push(format(_('Since %s'), formatTime(status.since)));
			details.push(formatDuration(Date.now() - status.since));
		};
	} else {
		title = _('No alert');
		if (state.clearedAt) {
			details.push(format(_('All clear at %s'), formatTime(state.clearedAt)));
		};
		if (state.error) {
			details.push(_('Data may be outdated'));
		};
	};

	body.add_child(createLabel(title, 'widget-alerts-title', `color: ${text};`));
	for (const detail of details) {
		body.add_child(createLabel(detail, 'widget-alerts-detail', `color: ${muted};`));
	};
};

export function render(context) {
	const {body, settings} = context;

	if (!liveBodies.has(body)) {
		body.connect('destroy', () => liveBodies.delete(body));
	};

	liveBodies.set(body, context);
	build(body, context);

	const regionChanged = (settings?.get_string('alerts-region-id') ?? '') !== (state.regionId ?? '');

	if (state.pollId && regionChanged) {
		state.settings = settings;
		poll();
	};
	startPolling(settings);
};
