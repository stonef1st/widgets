import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { warn } from './logger.js';
import { HttpError, createSession, fetchBytes, fetchJson } from './net.js';

// ClickUp data shared by the tasks widget and the top bar timer. Polling runs
// only while something listens. The personal token gives access to everything
// its owner can see, so it stays in a file of its own, never in the settings,
// and is only ever sent to api.clickup.com.

const API_URL = 'https://api.clickup.com/api/v2';
const TASK_URL = 'https://app.clickup.com/t';
const TASKS_SECONDS = 120;
const TIMER_SECONDS = 30;

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export const TOKEN_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'widgets-uk', 'clickup-token']);
const AVATARS_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'widgets-uk', 'clickup-avatars']);

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const state = {
	session: null,
	cancellable: null,
	tasksId: 0,
	timerId: 0,
	settings: null,
	teamId: null,
	userId: null,
	tasks: null,
	timer: null,
	avatarsVersion: 0,
	fetchingTasks: false,
	fetchingTimer: false,
	// null | 'token' (missing or rejected) | 'error'
	problem: null,
};
const listeners = new Set();
const failedAvatars = new Set();

function snapshot() {
	return {problem: state.problem, tasks: state.tasks, timer: state.timer, avatarsVersion: state.avatarsVersion};
};

function notifyListeners() {
	const current = snapshot();

	for (const listener of listeners) {
		listener(current);
	};
};

function cachedAvatarPath(url) {
	return GLib.build_filenamev([AVATARS_DIR, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, url, -1)]);
};

// Path of an already downloaded picture, or null.
export function avatarPath(url) {
	if (!url) {
		return null;
	};

	const path = cachedAvatarPath(url);

	return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
};

// Pictures are public URLs from the API, downloaded once. Until one is here,
// or if it fails, the widget shows initials.
async function fetchAvatars(tasks) {
	const urls = new Set(tasks.flatMap(task => task.assignees.map(person => person.picture)).filter(Boolean));
	let fetched = false;

	for (const url of urls) {
		if (avatarPath(url) || failedAvatars.has(url) || !url.startsWith('https://')) {
			continue;
		};

		try {
			const bytes = await fetchBytes(state.session, url, state.cancellable);

			if (bytes.get_size() > MAX_AVATAR_BYTES) {
				throw new Error('picture is too large');
			};

			GLib.mkdir_with_parents(AVATARS_DIR, 0o700);
			GLib.file_set_contents(cachedAvatarPath(url), bytes.get_data());
			fetched = true;
		} catch (error) {
			if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
				return;
			};

			failedAvatars.add(url);
			warn('clickup-avatar', `Could not fetch a ClickUp avatar: ${error.message}`);
		};
	};

	if (fetched) {
		state.avatarsVersion++;
		notifyListeners();
	};
};

async function readToken() {
	try {
		const [contents] = await Gio.File.new_for_path(TOKEN_PATH).load_contents_async(state.cancellable);

		return new TextDecoder().decode(contents).trim() || null;
	} catch (error) {
		if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
			!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
			warn('clickup-token', `Could not read the ClickUp token: ${error.message}`);
		};
		return null;
	};
};

// Runs one request cycle. The token is reread each time, so adding or
// replacing the file needs no relogin.
async function withApi(request) {
	try {
		const token = await readToken();

		if (!token) {
			if (state.cancellable && !state.cancellable.is_cancelled()) {
				state.problem = 'token';
			};
			return;
		};

		const get = path => fetchJson(state.session, `${API_URL}${path}`, state.cancellable, {
			'Authorization': token,
			'Content-Type': 'application/json',
		});

		if (!state.teamId || !state.userId) {
			const [{user}, {teams}] = await Promise.all([get('/user'), get('/team')]);

			state.userId = user?.id ?? null;
			state.teamId = teams?.[0]?.id ?? null;
		};

		if (state.teamId) {
			await request(get);
			state.problem = null;
		};
	} catch (error) {
		if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
			return;
		};

		const rejected = error instanceof HttpError && [401, 403].includes(error.status);

		state.problem = rejected ? 'token' : 'error';

		if (rejected) {
			state.teamId = null;
			state.userId = null;
		};

		warn('clickup-fetch', `Could not fetch ClickUp data: ${error.message}`);
	};
};

function taskFromApi(task) {
	const due = Number(task.due_date);

	return {
		id: task.id,
		name: task.name,
		url: task.url,
		due: Number.isFinite(due) && due > 0 ? due : null,
		priority: task.priority?.priority ?? null,
		assignees: (task.assignees ?? []).map(person => ({
			id: person.id,
			name: person.username ?? '',
			initials: person.initials ?? '',
			color: person.color ?? null,
			picture: person.profilePicture ?? null,
		})),
	};
};

// Nearest due date first, tasks without one after them.
function byDueDate(a, b) {
	return (a.due ?? Infinity) - (b.due ?? Infinity);
};

async function fetchTasks() {
	if (state.fetchingTasks) {
		return;
	};

	state.fetchingTasks = true;
	await withApi(async get => {
		const status = state.settings.get_string('clickup-status').trim();
		const listId = state.settings.get_string('clickup-list-id').trim();
		const query = [`statuses%5B%5D=${encodeURIComponent(status)}`];

		if (state.settings.get_boolean('clickup-only-mine')) {
			query.push(`assignees%5B%5D=${state.userId}`);
		};

		if (listId) {
			query.push(`list_ids%5B%5D=${encodeURIComponent(listId)}`);
		};

		const {tasks} = await get(`/team/${state.teamId}/task?${query.join('&')}`);

		state.tasks = (tasks ?? []).map(taskFromApi).sort(byDueDate);
	});
	state.fetchingTasks = false;
	notifyListeners();

	if (state.tasks && state.session) {
		fetchAvatars(state.tasks).catch(logError);
	};
};

async function fetchTimer() {
	if (state.fetchingTimer) {
		return;
	};

	state.fetchingTimer = true;
	await withApi(async get => {
		const {data} = await get(`/team/${state.teamId}/time_entries/current`);
		const start = Number(data?.start);

		// What the API returns with no timer running is undocumented, and a
		// negative duration is what marks a running one.
		state.timer = data?.id && Number(data.duration) < 0 && Number.isFinite(start)
			? {
				start,
				name: data.task?.name || data.description || null,
				url: data.task?.id ? `${TASK_URL}/${data.task.id}` : null,
			}
			: null;
	});
	state.fetchingTimer = false;
	notifyListeners();
};

function start() {
	if (state.tasksId) {
		return;
	};

	state.session = createSession();
	state.cancellable = new Gio.Cancellable();
	state.tasksId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TASKS_SECONDS, () => {
		fetchTasks();
		return GLib.SOURCE_CONTINUE;
	});
	state.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMER_SECONDS, () => {
		fetchTimer();
		return GLib.SOURCE_CONTINUE;
	});
	fetchTasks();
	fetchTimer();
};

function stop() {
	for (const key of ['tasksId', 'timerId']) {
		if (state[key]) {
			GLib.source_remove(state[key]);
			state[key] = 0;
		};
	};

	state.cancellable?.cancel();
	state.cancellable = null;
	state.session?.abort();
	state.session = null;
	state.fetchingTasks = false;
	state.fetchingTimer = false;
};

// The listener gets {problem, tasks, timer, avatarsVersion} now and after every fetch.
// Returns the unsubscribe.
export function subscribe(settings, listener) {
	state.settings = settings;
	listeners.add(listener);
	listener(snapshot());
	start();

	return () => {
		listeners.delete(listener);

		if (listeners.size === 0) {
			stop();
		};
	};
};

// Also covers a new token, which may belong to another account.
export function refresh() {
	state.teamId = null;
	state.userId = null;

	if (state.tasksId) {
		fetchTasks();
		fetchTimer();
	};
};

// For the refresh button. Resolves once the task list has been fetched.
export function refreshNow() {
	if (!state.tasksId) {
		return Promise.resolve();
	};

	fetchTimer();
	return fetchTasks();
};

export function hasToken() {
	return GLib.file_test(TOKEN_PATH, GLib.FileTest.EXISTS);
};

// Called from the preferences window. Owner-only file, replaced as a whole.
export function saveToken(token) {
	GLib.mkdir_with_parents(GLib.path_get_dirname(TOKEN_PATH), 0o700);
	Gio.File.new_for_path(TOKEN_PATH).replace_contents(
		new TextEncoder().encode(`${token.trim()}\n`),
		null,
		false,
		Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
		null);
};

export function forgetToken() {
	if (hasToken()) {
		Gio.File.new_for_path(TOKEN_PATH).delete(null);
	};
};

export function openTask(url) {
	if (url?.startsWith('https://')) {
		Gio.AppInfo.launch_default_for_uri(url, null);
	};
};

export function cleanup() {
	stop();
	listeners.clear();
	state.settings = null;
	state.teamId = null;
	state.userId = null;
	state.tasks = null;
	state.timer = null;
	state.problem = null;
};
