import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as AlertsWidget from './widgets/alerts/widget.js';
import * as WeatherWidget from './widgets/weather/widget.js';

const SYSTEM_ITEMS = ['screenRecording', 'screenSharing', 'dwellClick', 'a11y', 'keyboard', 'quickSettings'];

function openWeatherApp() {
	Main.overview.hide();
	Shell.AppSystem.get_default().lookup_app(WeatherWidget.appIds[0])?.activate();
};

// Listed in the order they stand next to each other inside a panel zone.
const ITEMS = [
	{name: 'alerts', key: 'panel-alerts', positionKey: 'panel-alerts-position', onClick: null},
	{name: 'weather', key: 'panel-weather', positionKey: 'panel-weather-position', onClick: openWeatherApp},
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
	constructor(role, name, box, index, onClick) {
		this._box = box;
		this._icon = new St.Icon({style_class: 'system-status-icon'});
		this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
		this._content = new St.BoxLayout();
		this._content.add_child(this._icon);
		this._content.add_child(this._label);

		this._button = new PanelMenu.Button(0.0, name, true);
		this._button.add_style_class_name('widget-panel-item');
		this._button.add_child(this._content);
		this._button.visible = false;
		this._button.reactive = Boolean(onClick);

		if (onClick) {
			this._button.connect('button-press-event', () => {
				onClick();
				return Clutter.EVENT_STOP;
			});
		};

		Main.panel.addToStatusArea(role, this._button, index, box);
	};

	show(iconName, text, styleClass = '') {
		this._icon.icon_name = iconName;
		this._label.text = text;
		this._content.style_class = styleClass;
		this._label.visible = true;
		this._button.visible = true;
	};

	// Measured with the label on, so hiding it cannot flip the result.
	dropLabelIfNarrow() {
		this._label.visible = zoneFits(this._box);
	};

	hide() {
		this._button.visible = false;
	};

	destroy() {
		this._button.destroy();
	};
};

export class PanelItems {
	constructor(uuid, settings) {
		this._uuid = uuid;
		this._settings = settings;
		this._items = new Map();
		this._weather = null;
		this._unsubscribeAlerts = null;
	};

	// Rebuilds every item, which is what keeps their relative order fixed.
	sync() {
		this.destroy();

		const placed = {left: 0, center: 0};

		for (const {name, key, positionKey, onClick} of ITEMS) {
			if (!this._settings.get_boolean(key)) {
				continue;
			};

			const box = this._settings.get_string(positionKey);
			// Left goes right after Activities, center before the clock.
			const index = box === 'right'
				? rightBoxIndex()
				: (box === 'left' ? 1 : 0) + placed[box]++;

			this._items.set(name, new PanelItem(`${this._uuid}-${name}`, name, box, index, onClick));
		};

		this.updateWeather(this._weather);

		if (this._items.has('alerts')) {
			this._unsubscribeAlerts = AlertsWidget.subscribe(this._settings, status => this._showAlerts(status));
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

		item?.show(WeatherWidget.symbolicIconName(weather.icon), weather.temp);
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

		item.show('dialog-warning-symbolic', label, active ? 'widget-panel-alert' : 'widget-panel-alert-unknown');
		item.dropLabelIfNarrow();
	};

	destroy() {
		this._unsubscribeAlerts?.();
		this._unsubscribeAlerts = null;

		for (const item of this._items.values()) {
			item.destroy();
		};

		this._items.clear();
	};
};
