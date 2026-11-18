import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { openTask, setNotifier } from './clickup.js';
import { _, format } from './i18n.js';

// Shell side of the ClickUp notifications: clickup.js finds the new tasks,
// this shows them. Kept apart because the preferences window imports
// clickup.js and cannot load the shell's modules.

const CLICKUP_ICON = Gio.FileIcon.new(
	Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons').get_child('clickup.svg'));
// Beyond this many at once, one summary instead of a banner per task.
const MAX_SEPARATE = 3;

let source = null;

// The tray drops a source once its last notification is gone.
function getSource() {
	if (!source) {
		source = new MessageTray.Source({title: 'ClickUp', icon: CLICKUP_ICON});
		source.connect('destroy', () => {
			source = null;
		});
		Main.messageTray.add(source);
	};

	return source;
};

function show(title, body, url) {
	const tray = getSource();
	const notification = new MessageTray.Notification({source: tray, title, body});

	if (url) {
		notification.connect('activated', () => openTask(url));
	};

	tray.addNotification(notification);
};

function notifyNewTasks(tasks, status) {
	if (tasks.length > MAX_SEPARATE) {
		show(format(_('New tasks in “%s”: %s'), status, tasks.length), tasks.map(task => task.name).join('\n'), null);
		return;
	};

	for (const task of tasks) {
		show(task.name, format(_('New task in “%s”'), status), task.url);
	};
};

export function enable() {
	setNotifier(notifyNewTasks);
};

export function disable() {
	setNotifier(null);
	source?.destroy();
	source = null;
};
