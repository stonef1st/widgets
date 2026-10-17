import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { _, format } from '../../i18n.js';
import { warn } from '../../logger.js';
import { HttpError, createSession, fetchJson } from '../../net.js';
import { ProgressRing, RING_COLORS } from '../../ring.js';

export const type = 'claude';
export const label = 'Claude Usage';
export const stylesheet = 'widgets/claude/stylesheet.css';
export const defaultSize = 'medium';
export const optional = true;

// Same endpoint Claude Code uses for /usage. It is not a public API, so the
// response shape may change without notice.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const FETCH_SECONDS = 5 * 60;
const RENDER_SECONDS = 60;
const LIMITS = [
	['five_hour', 'Session (5 h)'],
	['seven_day', 'Week'],
];

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const state = {
	session: null,
	cancellable: null,
	fetchId: 0,
	renderId: 0,
	fetching: false,
	data: null,
	// null | 'login' (no usable token) | 'error'
	problem: null,
};
const liveBodies = new Map();

// The token is only read here, never refreshed: refreshing rotates the
// refresh token and would log Claude Code out.
async function readToken() {
	try {
		const [contents] = await Gio.File.new_for_path(CREDENTIALS_PATH).load_contents_async(state.cancellable);
		const oauth = JSON.parse(new TextDecoder().decode(contents)).claudeAiOauth;

		if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt <= Date.now())) {
			return null;
		};

		return oauth.accessToken;
	} catch (error) {
		if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
			warn('claude-credentials', `Could not read Claude credentials: ${error.message}`);
		};
		return null;
	};
};

async function fetchData() {
	if (state.fetching) {
		return;
	};

	state.fetching = true;
	try {
		const token = await readToken();

		if (!token) {
			state.problem = 'login';
			return;
		};

		state.data = await fetchJson(state.session, USAGE_URL, state.cancellable, {
			'Authorization': `Bearer ${token}`,
			'anthropic-beta': 'oauth-2025-04-20',
		});
		state.problem = null;
	} catch (error) {
		if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
			return;
		};

		state.problem = error instanceof HttpError && [401, 403].includes(error.status) ? 'login' : 'error';
		warn('claude-fetch', `Could not fetch Claude usage: ${error.message}`);
	} finally {
		state.fetching = false;
		rerender();
	};
};

function start() {
	if (state.fetchId) {
		return;
	};

	state.session = createSession();
	state.cancellable = new Gio.Cancellable();
	state.fetchId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FETCH_SECONDS, () => {
		fetchData();
		return GLib.SOURCE_CONTINUE;
	});
	// Reset countdowns move with the clock even without new data.
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

function rerender() {
	for (const [body, context] of liveBodies) {
		body.destroy_all_children();
		build(body, context);
	};
};

// Accent up to 50%, yellow above 50%, red above 70%.
function usageColor(percentage, theme) {
	if (percentage > 70) {
		return RING_COLORS.red;
	};
	if (percentage > 50) {
		return RING_COLORS.yellow;
	};

	return theme.accent;
};

function resetLabel(resetsAt) {
	const resetTime = resetsAt ? Date.parse(resetsAt) : Number.NaN;

	if (!Number.isFinite(resetTime)) {
		return _('Not started');
	};

	const minutes = Math.max(0, Math.ceil((resetTime - Date.now()) / 60000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor(minutes % 1440 / 60);

	if (days > 0) {
		return format(_('Resets in %s'), format(_('%s d %s h'), days, hours));
	};
	if (hours > 0) {
		return format(_('Resets in %s'), format(_('%s h %s min'), hours, minutes % 60));
	};

	return format(_('Resets in %s'), format(_('%s min'), minutes));
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

function createSlot(limit, title, theme, createLabel) {
	const percentage = Number.isFinite(limit?.utilization) ? Math.round(limit.utilization) : null;
	const slot = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-claude-slot',
		x_expand: true,
	});
	const gauge = new St.Widget({
		style_class: 'widget-claude-gauge',
		layout_manager: new Clutter.BinLayout(),
		x_align: Clutter.ActorAlign.CENTER,
	});
	const ring = new ProgressRing(percentage, usageColor(percentage ?? 0, theme), theme);
	const value = createLabel(percentage === null ? '—' : `${percentage}%`, 'widget-claude-percent', `color: ${theme.text};`);

	gauge.set_size(84, 84);
	ring.set_size(84, 84);
	value.x_align = Clutter.ActorAlign.CENTER;
	value.y_align = Clutter.ActorAlign.CENTER;
	gauge.add_child(ring);
	gauge.add_child(value);
	slot.add_child(gauge);

	for (const [text, styleClass, color] of [
		[_(title), 'widget-claude-title', theme.text],
		[resetLabel(limit?.resets_at), 'widget-claude-reset', theme.muted],
	]) {
		const labelActor = createLabel(text, styleClass, `color: ${color};`);

		labelActor.x_align = Clutter.ActorAlign.CENTER;
		slot.add_child(labelActor);
	};

	return slot;
};

function build(body, {createLabel, theme}) {
	if (!state.data || state.problem === 'login') {
		const message = new St.BoxLayout({
			orientation: Clutter.Orientation.VERTICAL,
			x_expand: true,
			y_expand: true,
			y_align: Clutter.ActorAlign.CENTER,
		});
		let [title, detail] = [_('Loading…'), _('Claude Usage')];

		if (state.problem === 'login') {
			[title, detail] = [_('Open Claude Code'), _('Sign-in token has expired')];
		} else if (state.problem === 'error') {
			[title, detail] = [_('No data'), _('Claude Usage')];
		};

		message.add_child(createLabel(title, 'widget-claude-message', `color: ${theme.text};`));
		message.add_child(createLabel(detail, 'widget-claude-reset', `color: ${theme.muted};`));
		body.add_child(message);
		return;
	};

	const tray = new St.BoxLayout({
		style_class: 'widget-claude-tray',
		x_expand: true,
		y_expand: true,
		y_align: Clutter.ActorAlign.CENTER,
	});

	for (const [key, title] of LIMITS) {
		tray.add_child(createSlot(state.data[key], title, theme, createLabel));
	};

	body.add_child(tray);
};

export function render(context) {
	const {body} = context;

	if (!liveBodies.has(body)) {
		body.connect('destroy', () => liveBodies.delete(body));
	};

	liveBodies.set(body, context);
	build(body, context);
	start();
};

export function cleanup() {
	stop();
	liveBodies.clear();
};
