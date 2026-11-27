import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { REGIONS_URL, indexRegions } from './alerts.js';
import { NOTIFY_SOUNDS, forgetToken, hasToken, saveToken, themeSoundPath } from './clickup.js';
import { _, availableLanguages, setLanguage } from './i18n.js';
import { createSession, fetchJson } from './net.js';
import { GROUPS, PROVIDERS, groupLabel } from './outages.js';
import { ADAPTERS } from './planned.js';

// Language names are shown in their own language, never translated.
const LANGUAGE_NAMES = {
	en: 'English',
	uk: 'Українська',
};

// Untranslated menu labels of NOTIFY_SOUNDS, passed through _() when shown.
const SOUND_LABELS = {
	'message-new-instant': 'Instant message',
	'message': 'Message',
	'bell': 'Bell',
	'complete': 'Complete',
	'dialog-information': 'Information',
	'dialog-warning': 'Warning',
	'alarm-clock-elapsed': 'Alarm clock',
	'phone-incoming-call': 'Incoming call',
};

function stringComboRow({title, subtitle = null, values, labels, settings, key, search = false}) {
	const model = Gtk.StringList.new(labels);
	const row = new Adw.ComboRow({title, model});

	if (subtitle) {
		row.subtitle = subtitle;
	};

	if (search) {
		row.enable_search = true;
		row.expression = new Gtk.PropertyExpression(Gtk.StringObject, null, 'string');
	};

	const sync = () => {
		const index = values.indexOf(settings.get_string(key));

		row.selected = index >= 0 ? index : 0;
	};

	sync();
	row.connect('notify::selected', () => {
		const value = values[row.selected];

		if (value !== undefined && value !== settings.get_string(key)) {
			settings.set_string(key, value);
		};
	});

	return row;
};

function regionLabel(regions, region) {
	const parent = region.parentId ? regions.get(region.parentId) : null;

	return parent ? `${region.name} (${parent.name})` : region.name;
};

export default class WidgetsPreferences extends ExtensionPreferences {
	async fillPreferencesWindow(window) {
		const settings = this.getSettings();

		setLanguage(settings.get_string('language'));
		window.set_default_size(640, 720);

		const page = new Adw.PreferencesPage({
			title: _('Widgets'),
			icon_name: 'view-grid-symbolic',
		});

		window.add(page);
		page.add(this._generalGroup(settings));
		page.add(this._weatherGroup(settings));
		page.add(this._calendarGroup(settings));
		page.add(this._alertsGroup(settings));
		page.add(this._outagesGroup(settings));
		page.add(this._addressOutagesGroup(settings));
		page.add(this._claudeGroup(settings));
		page.add(this._clickUpGroup(settings));
	};

	_generalGroup(settings) {
		const group = new Adw.PreferencesGroup({title: _('General')});
		const languages = availableLanguages();

		group.add(stringComboRow({
			title: _('Language'),
			subtitle: _('Reopen settings to see them in the new language'),
			values: ['auto', ...languages],
			labels: [_('Automatic'), ...languages.map(code => LANGUAGE_NAMES[code] ?? code)],
			settings,
			key: 'language',
		}));
		group.add(stringComboRow({
			title: _('First day of week'),
			values: ['auto', 'monday', 'sunday'],
			labels: [_('Automatic'), _('Monday'), _('Sunday')],
			settings,
			key: 'first-day-of-week',
		}));

		const glassRow = new Adw.SwitchRow({
			title: _('Glass widgets'),
			subtitle: _('Blurred wallpaper behind widgets with a highlight along the edges'),
		});

		settings.bind('widget-glass', glassRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(glassRow);

		const panelRow = new Adw.SwitchRow({
			title: _('Top bar button'),
			subtitle: _('Edit mode and adding widgets live in this button'),
		});

		settings.bind('show-panel-button', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(panelRow);

		return group;
	};

	_addPanelRows(group, settings, key, subtitle) {
		const showRow = new Adw.SwitchRow({
			title: _('Show in the top bar'),
			subtitle,
		});
		const positionRow = stringComboRow({
			title: _('Position in the top bar'),
			values: ['left', 'center', 'right'],
			labels: [_('Left'), _('Center'), _('Right')],
			settings,
			key: `${key}-position`,
		});

		settings.bind(key, showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind(key, positionRow, 'sensitive', Gio.SettingsBindFlags.GET);
		group.add(showRow);
		group.add(positionRow);
	};

	_weatherGroup(settings) {
		const group = new Adw.PreferencesGroup({title: _('Weather')});

		this._addPanelRows(group, settings, 'panel-weather', _('Icon and temperature'));
		return group;
	};

	_clickUpGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: 'ClickUp',
			description: _('The token is kept in a separate file only you can read, not in the settings.'),
		});
		const mineRow = new Adw.SwitchRow({title: _('Only my tasks')});
		const notifyRow = new Adw.SwitchRow({
			title: _('Notifications'),
			subtitle: _('Notify when a new task appears in this status'),
		});

		group.add(this._tokenRow(settings));
		group.add(this._entryRow(settings, 'clickup-status', _('Status in the widget')));
		group.add(this._entryRow(settings, 'clickup-list-id', _('List ID (empty: whole workspace)')));
		settings.bind('clickup-only-mine', mineRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(mineRow);
		settings.bind('clickup-notify', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(notifyRow);
		this._addTurboRows(group, settings);
		this._addPanelRows(group, settings, 'panel-clickup', _('Running timer, only while it runs'));
		return group;
	};

	// The sound rows only show while turbo is on, and all of them grey out
	// with notifications off.
	_addTurboRows(group, settings) {
		const turboRow = new Adw.SwitchRow({
			title: _('Turbo notifications'),
			subtitle: _('With a sound, stay until closed, also in Do Not Disturb and over full-screen windows'),
		});
		const soundRow = stringComboRow({
			title: _('Sound'),
			values: ['none', ...NOTIFY_SOUNDS, 'file'],
			labels: [_('No sound'), ...NOTIFY_SOUNDS.map(name => _(SOUND_LABELS[name])), _('Own file…')],
			settings,
			key: 'clickup-notify-sound',
		});
		const fileRow = new Adw.ActionRow({title: _('Sound file')});
		const playButton = new Gtk.Button({
			icon_name: 'media-playback-start-symbolic',
			tooltip_text: _('Listen'),
			valign: Gtk.Align.CENTER,
			css_classes: ['flat'],
		});
		const chooseButton = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
		// Kept so the preview is not collected while it plays.
		let preview = null;

		const soundPath = () => {
			const choice = settings.get_string('clickup-notify-sound');

			if (choice === 'none') {
				return null;
			};

			if (choice === 'file') {
				const path = settings.get_string('clickup-notify-sound-file');

				return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
			};

			return themeSoundPath(choice);
		};
		const sync = () => {
			const turbo = settings.get_boolean('clickup-notify-urgent');
			const path = settings.get_string('clickup-notify-sound-file');

			soundRow.visible = turbo;
			fileRow.visible = turbo && settings.get_string('clickup-notify-sound') === 'file';
			fileRow.subtitle = path ? GLib.path_get_basename(path) : _('No file chosen');
			playButton.sensitive = soundPath() !== null;
		};

		settings.bind('clickup-notify-urgent', turboRow, 'active', Gio.SettingsBindFlags.DEFAULT);

		for (const row of [turboRow, soundRow, fileRow]) {
			settings.bind('clickup-notify', row, 'sensitive', Gio.SettingsBindFlags.GET);
		};

		playButton.connect('clicked', () => {
			const path = soundPath();

			preview?.set_playing(false);
			preview = path ? Gtk.MediaFile.new_for_filename(path) : null;
			preview?.play();
		});
		chooseButton.connect('clicked', () => {
			const filter = new Gtk.FileFilter({name: _('Sounds')});
			const filters = new Gio.ListStore({item_type: Gtk.FileFilter});

			filter.add_mime_type('audio/*');
			filters.append(filter);

			const dialog = new Gtk.FileDialog({title: _('Sound file'), filters, default_filter: filter});

			dialog.open(fileRow.get_root(), null, (_dialog, result) => {
				try {
					const path = dialog.open_finish(result)?.get_path();

					if (path) {
						settings.set_string('clickup-notify-sound-file', path);
					};
				} catch (error) {
					// Dismissing the dialog also lands here.
					if (!error.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED)) {
						fileRow.subtitle = `${_('Could not open the file')}: ${error.message}`;
					};
				};
			});
		});

		soundRow.add_suffix(playButton);
		fileRow.add_suffix(chooseButton);

		for (const key of ['clickup-notify-urgent', 'clickup-notify-sound', 'clickup-notify-sound-file']) {
			settings.connect(`changed::${key}`, sync);
		};

		sync();
		group.add(turboRow);
		group.add(soundRow);
		group.add(fileRow);
	};

	// The stamp holds no secret: it only tells the shell to reread the token.
	_tokenRow(settings) {
		const row = new Adw.PasswordEntryRow({show_apply_button: true});
		const forget = new Gtk.Button({
			icon_name: 'user-trash-symbolic',
			tooltip_text: _('Forget the token'),
			valign: Gtk.Align.CENTER,
			css_classes: ['flat'],
		});
		const sync = () => {
			const saved = hasToken();

			row.title = saved ? _('Token saved; enter a new one to replace it') : _('Personal API token');
			forget.visible = saved;
		};
		const changed = change => {
			try {
				change();
				row.text = '';
				sync();
				settings.set_int64('clickup-token-stamp', Date.now());
			} catch (error) {
				row.title = `${_('Could not save the token')}: ${error.message}`;
			};
		};

		row.add_suffix(forget);
		row.connect('apply', () => {
			if (row.text.trim()) {
				changed(() => saveToken(row.text));
			};
		});
		forget.connect('clicked', () => changed(forgetToken));
		sync();
		return row;
	};

	// Saved on apply rather than on every keystroke, each save refetches.
	_entryRow(settings, key, title) {
		const row = new Adw.EntryRow({title, show_apply_button: true, text: settings.get_string(key)});

		row.connect('apply', () => settings.set_string(key, row.text.trim()));
		return row;
	};

	_claudeGroup(settings) {
		const group = new Adw.PreferencesGroup({title: _('Claude Usage')});

		this._addPanelRows(group, settings, 'panel-claude', _('Icon and the limit closest to running out'));
		return group;
	};

	_calendarGroup(settings) {
		const group = new Adw.PreferencesGroup({title: _('Calendar')});
		const row = new Adw.SwitchRow({
			title: _('Show events'),
			subtitle: _('Marks under days with events; a wide calendar also lists upcoming events. Uses the calendars from the top bar.'),
		});

		settings.bind('calendar-show-events', row, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(row);
		this._addPanelRows(group, settings, 'panel-calendar', _('Only in the hour before an event with a set time'));
		return group;
	};

	_alertsGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: _('Air Raid Alerts'),
			description: _('Data: siren.pp.ua (ukrainealarm.com). Alerts for the whole oblast and for communities inside the region also count.'),
		});
		const regionRow = new Adw.ActionRow({
			title: _('Region'),
			subtitle: settings.get_string('alerts-region-name') || _('Loading regions…'),
		});
		const notifyRow = new Adw.SwitchRow({
			title: _('Notifications'),
			subtitle: _('Notify when an alert starts or ends'),
		});

		settings.bind('alerts-notify', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(regionRow);
		group.add(notifyRow);
		this._addPanelRows(group, settings, 'panel-alerts', _('Only during an alert or when the service is unavailable'));
		this._loadRegions(settings, group, regionRow);
		return group;
	};

	async _loadRegions(settings, group, placeholderRow) {
		let regions;

		try {
			regions = indexRegions(await fetchJson(createSession(), REGIONS_URL));
		} catch (error) {
			placeholderRow.subtitle = `${_('Could not load regions')}: ${error.message}`;
			return;
		};

		const items = [...regions.values()];
		const values = ['', ...items.map(region => region.id)];
		const labels = [_('Not set'), ...items.map(region => regionLabel(regions, region))];
		const row = stringComboRow({
			title: _('Region'),
			subtitle: _('Oblast, district or community; type to search'),
			values,
			labels,
			settings,
			key: 'alerts-region-id',
			search: true,
		});

		row.connect('notify::selected', () => {
			const region = regions.get(values[row.selected]);

			settings.set_string('alerts-region-name', region?.name ?? '');
		});

		group.remove(placeholderRow);
		group.add(row);
	};

	_outagesGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: _('Power Outages'),
			description: _('Hourly schedules (ГПВ) from github.com/yaroslav2901/OE_OUTAGE_DATA. Your group is on your oblenergo website or bill.'),
		});

		group.add(stringComboRow({
			title: _('Provider'),
			values: ['', ...PROVIDERS.map(([id]) => id)],
			labels: [_('Not set'), ...PROVIDERS.map(([, name]) => _(name))],
			settings,
			key: 'outage-provider',
		}));
		group.add(stringComboRow({
			title: _('Group'),
			subtitle: _('Queue and subqueue'),
			values: ['', ...GROUPS],
			labels: [_('Not set'), ...GROUPS.map(groupLabel)],
			settings,
			key: 'outage-group',
		}));
		this._addPanelRows(group, settings, 'panel-power', _('Only before and during an outage'));

		return group;
	};

	// Planned and emergency outages by address, for providers with an adapter.
	_addressOutagesGroup(settings) {
		const group = new Adw.PreferencesGroup({
			title: _('Outages by address'),
			description: _('Planned works and emergency outages from the oblenergo website. Write the address as the website does; street words may go in any order.'),
		});
		const areaRows = Object.entries(ADAPTERS).map(([provider, adapter]) => {
			const row = stringComboRow({
				title: _('Network district'),
				subtitle: adapter.source,
				values: ['', ...adapter.areas.map(([id]) => id)],
				labels: [_('Not set'), ...adapter.areas.map(([, name]) => name)],
				settings,
				key: 'outage-area',
			});

			group.add(row);
			return [provider, row];
		});
		const unsupported = new Adw.ActionRow({title: _('Not available for this provider yet')});

		group.add(unsupported);
		group.add(this._entryRow(settings, 'outage-city', _('Settlement')));
		group.add(this._entryRow(settings, 'outage-street', _('Street')));
		group.add(this._entryRow(settings, 'outage-house', _('House')));

		const sync = () => {
			const provider = settings.get_string('outage-provider');
			const supported = provider in ADAPTERS;

			for (const [id, row] of areaRows) {
				row.visible = id === provider;
			};

			unsupported.visible = !supported;
			group.sensitive = supported;
		};

		sync();
		const handler = settings.connect('changed::outage-provider', sync);

		group.connect('destroy', () => settings.disconnect(handler));
		return group;
	};
};
