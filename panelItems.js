import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as AlertsWidget from './widgets/alerts/widget.js';
import * as ClaudeWidget from './widgets/claude/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';

const SYSTEM_ITEMS = ['screenRecording', 'screenSharing', 'dwellClick', 'a11y', 'keyboard', 'quickSettings'];
const ALERT_ICON = Gio.ThemedIcon.new('dialog-warning-symbolic');
const CLAUDE_ICON = Gio.FileIcon.new(
	Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons/claude-symbolic.svg'));

function openWeatherApp() {
	Main.overview.hide();
	Shell.AppSystem.get_default().lookup_app(WeatherWidget.appIds[0])?.activate();
};

// Listed in the order they stand next to each other inside a panel zone.
const ITEMS = [
	{name: 'alerts', key: 'panel-alerts', positionKey: 'panel-alerts-position'},
	{name: 'weather', key: 'panel-weather', positionKey: 'panel-weather-position', onClick: openWeatherApp},
	{name: 'claude', key: 'panel-claude', positionKey: 'panel-claude-position', hasMenu: true},
];

// Other extensions insert at the start of the right box, in whatever order
// they load. Counting from the system items keeps our place stable.
function rightBoxIndex() {
	const first = SYSTEM_ITEMS.map(role => Main.panel.statusArea[role]).find(Boolean);

	return first ? first.container.get_parent().get_children().indexOf(first.container) : 0;
};

// Mirrors Panel.vfunc_allocate: the center keeps its natural width and each
// side gets half of the rest, cutting off whatever does not fit.
function zoneFits(box) {
	const {_leftBox: left, _centerBox: center, _rightBox: right} = Main.panel;
	const natural = actor => actor.get_preferred_width(-1)[1];
	const side = (Main.panel.width - natural(center)) / 2;

	return (box === 'right' || natural(left) <= side) && (box === 'left' || natural(right) <= side);
};

class PanelItem {
	constructor(role, name, box, index, {onClick = null, hasMenu = false}) {
		this._box = box;
		this._menuItems = [];
		this._icon = new St.Icon({style_class: 'system-status-icon'});
		this._label = new St.Label({style_class: 'widget-panel-label', y_align: Clutter.ActorAlign.CENTER});
		this._content = new St.BoxLayout();
		this._content.add_child(this._icon);
		this._content.add_child(this._label);

		this._button = new PanelMenu.Button(0.0, name, !hasMenu);
		this._button.add_style_class_name('widget-panel-item');
		this._button.add_child(this._content);
		this._button.visible = false;
		this._button.reactive = hasMenu || Boolean(onClick);

		if (onClick) {
			this._button.connect('button-press-event', () => {
				onClick();
				return Clutter.EVENT_STOP;
			});
		};

		Main.panel.addToStatusArea(role, this._button, index, box);
	};

	show(gicon, text, {styleClass = '', iconColor = null} = {}) {
		this._icon.gicon = gicon;
		this._icon.style = iconColor ? `color: ${iconColor};` : null;
		this._label.text = text;
		this._content.style_class = styleClass;
		this._label.visible = true;
		this._button.visible = true;
	};

	// Measured with the label on, so hiding it cannot flip the result.
	dropLabelIfNarrow() {
		this._label.visible = zoneFits(this._box);
	};

	// Reuses the rows, so a refresh does not disturb an open menu.
	setMenuLines(lines) {
		while (this._menuItems.length < lines.length) {
			const item = new PopupMenu.PopupMenuItem('', {reactive: false});

			this._button.menu.addMenuItem(item);
			this._menuItems.push(item);
		};

		this._menuItems.forEach((item, index) => {
			item.visible = index < lines.length;
			item.label.text = lines[index] ?? '';
		});
	};

	hide() {
		this._button.visible = false;
	};

	destroy() {
		this._button.destroy();
	};
};

export class PanelItems {
	constructor(uuid, settings, getTheme) {
		this._uuid = uuid;
		this._settings = settings;
		this._getTheme = getTheme;
		this._items = new Map();
		this._weather = null;
		this._unsubscribers = [];
	};

	// Rebuilds every item, which is what keeps their relative order fixed.
	sync() {
		this.destroy();

		const placed = {left: 0, center: 0};

		for (const {name, key, positionKey, ...options} of ITEMS) {
			if (!this._settings.get_boolean(key)) {
				continue;
			};

			const box = this._settings.get_string(positionKey);
			// Left goes right after Activities, center before the clock.
			const index = box === 'right'
				? rightBoxIndex()
				: (box === 'left' ? 1 : 0) + placed[box]++;

			this._items.set(name, new PanelItem(`${this._uuid}-${name}`, name, box, index, options));
		};

		this.updateWeather(this._weather);

		if (this._items.has('alerts')) {
			this._unsubscribers.push(AlertsWidget.subscribe(this._settings, status => this._showAlerts(status)));
		};

		if (this._items.has('claude')) {
			this._unsubscribers.push(ClaudeWidget.subscribe(usage => this._showClaude(usage)));
		};
	};

	// Without data the item stays hidden: a bare "--" only takes up room.
	updateWeather(weather) {
		this._weather = weather;

		const item = this._items.get('weather');

		if (!weather || weather.temp === '--') {
			item?.hide();
			return;
		};

		item?.show(Gio.ThemedIcon.new(WeatherWidget.symbolicIconName(weather.icon)), weather.temp);
	};

	// Silent while all is clear. When the service is down the item stays
	// visible, because an empty panel would read as "no alert". Rechecked on
	// every poll, so a narrower panel drops the text within one poll.
	_showAlerts({active, error, label}) {
		const item = this._items.get('alerts');

		if (!item) {
			return;
		};

		if (!active && !error) {
			item.hide();
			return;
		};

		item.show(ALERT_ICON, label, {styleClass: active ? 'widget-panel-alert' : 'widget-panel-muted'});
		item.dropLabelIfNarrow();
	};

	_showClaude(usage) {
		const item = this._items.get('claude');

		if (!item) {
			return;
		};

		if (!usage) {
			item.hide();
			return;
		};

		const {percentage, lines} = usage;

		item.setMenuLines(lines);

		if (percentage === null) {
			item.show(CLAUDE_ICON, '—', {styleClass: 'widget-panel-muted'});
		} else {
			item.show(CLAUDE_ICON, `${percentage}%`, {iconColor: ClaudeWidget.usageColor(percentage, this._getTheme())});
		};
	};

	destroy() {
		this._unsubscribers.forEach(unsubscribe => unsubscribe());
		this._unsubscribers = [];

		for (const item of this._items.values()) {
			item.destroy();
		};

		this._items.clear();
	};
};
