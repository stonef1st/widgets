import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { avatarPath, cleanup as cleanupData, openTask, refreshNow, subscribe } from '../../clickup.js';
import { _, format, intlLocale } from '../../i18n.js';

export const type = 'clickup';
export const label = 'ClickUp';
export const stylesheet = 'widgets/clickup/stylesheet.css';
export const defaultSize = 'medium';
export const optional = true;
// Rows take their own clicks instead of the whole card opening an app.
export const interactive = true;

const CLICKUP_ICON = Gio.FileIcon.new(
	Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent().get_child('icons').get_child('clickup.svg'));
const HEADER_HEIGHT = 60;
const ROW_HEIGHT = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cards at least this wide have room for several avatars in a row.
const WIDE_MIN_WIDTH = 400;
const AVATARS_WIDE = 3;
const AVATARS_NARROW = 1;
const AVATAR_FALLBACK_COLOR = '#5e5c64';
// Tinting every priority would paint the whole list, and most tasks are normal.
const TINTED_PRIORITIES = ['urgent', 'high'];

const liveBodies = new Map();
let unsubscribe = null;
let refreshing = false;
let snapshot = {problem: null, tasks: null, timer: null};

function rerender() {
	for (const [body, context] of liveBodies) {
		body.destroy_all_children();
		build(body, context);
	};
};

export function cleanup() {
	unsubscribe?.();
	unsubscribe = null;
	liveBodies.clear();
	snapshot = {problem: null, tasks: null, timer: null};
	cleanupData();
};

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

function singleLine(labelActor) {
	labelActor.clutter_text.set_line_wrap(false);
	labelActor.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
	labelActor.y_align = Clutter.ActorAlign.CENTER;
	return labelActor;
};

function dueLabel(due) {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const date = new Date(due);
	const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	const diff = Math.round((day - today) / DAY_MS);

	if (diff === 0) {
		return _('Today');
	};
	if (diff === 1) {
		return _('Tomorrow');
	};

	return date.toLocaleDateString(intlLocale(), {day: 'numeric', month: 'short'});
};

function isOverdue(due) {
	const now = new Date();

	return due < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

function buildAvatar(person) {
	const path = avatarPath(person.picture);

	if (path) {
		return new St.Widget({
			style_class: 'widget-clickup-avatar',
			style: `background-image: url("file://${path}"); background-size: cover;`,
			y_align: Clutter.ActorAlign.CENTER,
		});
	};

	return new St.Bin({
		style_class: 'widget-clickup-avatar',
		style: `background-color: ${person.color ?? AVATAR_FALLBACK_COLOR};`,
		y_align: Clutter.ActorAlign.CENTER,
		child: new St.Label({
			text: person.initials,
			style_class: 'widget-clickup-initials',
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
		}),
	});
};

function buildAvatars(people, limit, {createLabel, theme}) {
	const box = new St.BoxLayout({style_class: 'widget-clickup-avatars', y_align: Clutter.ActorAlign.CENTER});

	for (const person of people.slice(0, limit)) {
		box.add_child(buildAvatar(person));
	};

	if (people.length > limit) {
		const more = singleLine(createLabel(`+${people.length - limit}`, 'widget-clickup-avatars-more', `color: ${theme.muted};`));

		more.x_expand = false;
		box.add_child(more);
	};

	return box;
};

function buildRow(task, context) {
	const {createLabel, theme, widget, sizeForWidget} = context;
	const wide = sizeForWidget(widget)[0] >= WIDE_MIN_WIDTH;
	const row = new St.BoxLayout({style_class: 'widget-clickup-row-content', x_expand: true});
	const button = new St.Button({
		style_class: 'widget-clickup-row',
		child: row,
		x_expand: true,
		x_align: Clutter.ActorAlign.FILL,
		reactive: true,
		track_hover: true,
		accessible_name: task.name,
	});

	row.add_child(singleLine(createLabel(task.name, 'widget-clickup-task', `color: ${theme.text};`)));

	if (TINTED_PRIORITIES.includes(task.priority)) {
		button.add_style_class_name(`widget-clickup-row-${task.priority}`);
	};

	// A dot rather than red text: it stays readable on any priority tint.
	if (task.due && isOverdue(task.due)) {
		row.insert_child_at_index(new St.Widget({
			style_class: 'widget-clickup-overdue-dot',
			y_align: Clutter.ActorAlign.CENTER,
		}), 0);
	};

	if (task.due && wide) {
		const due = singleLine(createLabel(dueLabel(task.due), 'widget-clickup-due', `color: ${theme.muted};`));

		due.x_expand = false;
		row.add_child(due);
	};

	if (task.assignees.length > 0) {
		row.add_child(buildAvatars(task.assignees, wide ? AVATARS_WIDE : AVATARS_NARROW, context));
	};

	button.connect('clicked', () => openTask(task.url));
	return button;
};

function buildRefreshButton(theme) {
	const button = new St.Button({
		style_class: 'widget-clickup-refresh',
		child: new St.Icon({
			icon_name: 'view-refresh-symbolic',
			style_class: 'widget-clickup-refresh-icon',
			style: `color: ${theme.muted};`,
		}),
		y_align: Clutter.ActorAlign.CENTER,
		reactive: !refreshing,
		track_hover: true,
		opacity: refreshing ? 90 : 255,
		accessible_name: _('Refresh'),
	});

	button.connect('clicked', () => {
		refreshing = true;
		rerender();
		refreshNow().catch(logError).finally(() => {
			refreshing = false;
			rerender();
		});
	});

	return button;
};

function buildMessage(body, title, detail, {createLabel, theme}) {
	const message = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		x_expand: true,
		y_expand: true,
		y_align: Clutter.ActorAlign.CENTER,
	});

	message.add_child(createLabel(title, 'widget-clickup-message', `color: ${theme.text};`));

	if (detail) {
		message.add_child(createLabel(detail, 'widget-clickup-detail', `color: ${theme.muted};`));
	};

	body.add_child(message);
};

function build(body, context) {
	const {createLabel, theme, settings, widget, sizeForWidget} = context;
	const {problem, tasks} = snapshot;
	const status = settings?.get_string('clickup-status').trim() ?? '';
	const header = new St.BoxLayout({style_class: 'widget-clickup-header'});
	const title = createLabel(status.toUpperCase(), 'widget-clickup-title', `color: ${theme.muted};`);

	title.y_align = Clutter.ActorAlign.CENTER;
	header.add_child(new St.Icon({
		gicon: CLICKUP_ICON,
		style_class: 'widget-clickup-icon',
	}));
	header.add_child(title);

	if (tasks?.length) {
		const count = createLabel(String(tasks.length), 'widget-clickup-title', `color: ${theme.muted};`);

		count.x_expand = false;
		count.y_align = Clutter.ActorAlign.CENTER;
		header.add_child(count);
	};

	header.add_child(buildRefreshButton(theme));
	body.add_child(header);

	if (problem === 'token') {
		buildMessage(body, _('ClickUp token needed'), _('Open extension settings'), context);
		return;
	};

	if (!tasks) {
		buildMessage(body, problem ? _('No data') : _('Loading…'), null, context);
		return;
	};

	if (tasks.length === 0) {
		buildMessage(body, _('Nothing here'), null, context);
		return;
	};

	const [, height] = sizeForWidget(widget);
	const capacity = Math.max(1, Math.floor((height - HEADER_HEIGHT) / ROW_HEIGHT));
	// The last row becomes "+N more" when not everything fits.
	const shown = tasks.length > capacity ? capacity - 1 : tasks.length;

	for (const task of tasks.slice(0, shown)) {
		body.add_child(buildRow(task, context));
	};

	if (tasks.length > shown) {
		body.add_child(singleLine(createLabel(format(_('+%s more'), tasks.length - shown), 'widget-clickup-more', `color: ${theme.muted};`)));
	};
};

export function render(context) {
	const {body, settings} = context;

	if (!liveBodies.has(body)) {
		body.connect('destroy', () => {
			liveBodies.delete(body);

			if (liveBodies.size === 0) {
				unsubscribe?.();
				unsubscribe = null;
			};
		});
	};

	liveBodies.set(body, context);
	build(body, context);

	unsubscribe ??= subscribe(settings, data => {
		// Timer polls change nothing here, and a rebuild could swallow a click.
		const unchanged = data.tasks === snapshot.tasks && data.problem === snapshot.problem &&
			data.avatarsVersion === snapshot.avatarsVersion;

		snapshot = data;

		if (!unchanged) {
			rerender();
		};
	});
};
