import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as WeatherWidget from './widgets/weather/widget.js';

const SYSTEM_ITEMS = ['screenRecording', 'screenSharing', 'dwellClick', 'a11y', 'keyboard', 'quickSettings'];

// Other extensions insert at the start of the right box, in whatever order
// they load. Counting from the system items keeps our place stable.
function rightBoxIndex() {
	const first = SYSTEM_ITEMS.map(role => Main.panel.statusArea[role]).find(Boolean);

	return first ? first.container.get_parent().get_children().indexOf(first.container) : 0;
};

// Left goes right after Activities, center before the clock.
function boxIndex(box) {
	return {left: 1, center: 0, right: rightBoxIndex()}[box];
};

function openWeatherApp() {
	Main.overview.hide();
	Shell.AppSystem.get_default().lookup_app(WeatherWidget.appIds[0])?.activate();
};

export class PanelWeather {
	constructor(role, position) {
		const box = ['left', 'center', 'right'].includes(position) ? position : 'right';

		this._icon = new St.Icon({style_class: 'system-status-icon'});
		this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});

		const content = new St.BoxLayout();

		content.add_child(this._icon);
		content.add_child(this._label);

		this._button = new PanelMenu.Button(0.0, 'Weather', true);
		this._button.add_child(content);
		this._button.visible = false;
		this._button.connect('button-press-event', () => {
			openWeatherApp();
			return Clutter.EVENT_STOP;
		});

		Main.panel.addToStatusArea(role, this._button, boxIndex(box), box);
	};

	// Without data the item stays hidden: a bare "--" only takes up room.
	update(weather) {
		if (!weather || weather.temp === '--') {
			this._button.visible = false;
			return;
		};

		this._icon.icon_name = WeatherWidget.symbolicIconName(weather.icon);
		this._label.text = weather.temp;
		this._button.visible = true;
	};

	destroy() {
		this._button.destroy();
		this._button = null;
	};
};
