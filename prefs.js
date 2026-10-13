import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { REGIONS_URL, indexRegions } from './alerts.js';
import { _, availableLanguages, setLanguage } from './i18n.js';
import { createSession, fetchJson } from './net.js';
import { GROUPS, PROVIDERS, groupLabel } from './outages.js';

// Language names are shown in their own language, never translated.
const LANGUAGE_NAMES = {
	en: 'English',
	uk: 'Українська',
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
		page.add(this._calendarGroup(settings));
		page.add(this._alertsGroup(settings));
		page.add(this._outagesGroup(settings));
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

		const panelRow = new Adw.SwitchRow({
			title: _('Top bar button'),
			subtitle: _('Edit mode and adding widgets live in this button'),
		});

		settings.bind('show-panel-button', panelRow, 'active', Gio.SettingsBindFlags.DEFAULT);
		group.add(panelRow);

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

		return group;
	};
};
