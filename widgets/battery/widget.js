import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { warn } from '../../logger.js';

export const type = 'battery';
export const label = 'Батарея';
export const stylesheet = 'widgets/battery/stylesheet.css';
export const defaultSize = 'medium';

const SLOT_COUNT = 4;
const DBUS_TIMEOUT_MS = 1000;

Gio._promisify(Gio.DBusConnection.prototype, 'call');

let cachedDevices = null;
let readInFlight = false;
let readPending = false;
const liveBodies = new Map();

const DEVICE_TYPE = {
	BATTERY: 2,
	UPS: 3,
	MOUSE: 5,
	KEYBOARD: 6,
	PDA: 7,
	PHONE: 8,
	MEDIA_PLAYER: 9,
	TABLET: 10,
	COMPUTER: 11,
	GAMING_INPUT: 12,
	PEN: 13,
	TOUCHPAD: 14,
	HEADSET: 17,
	SPEAKERS: 18,
	HEADPHONES: 19,
	OTHER_AUDIO: 21,
};

const UPOWER_STATE = {
	CHARGING: 1,
	FULLY_CHARGED: 4,
};

function variantValue(props, name, fallback = null) {
	return props[name] ? props[name].deep_unpack() : fallback;
};

function batteryColor(percentage) {
	if (percentage <= 20) {
		return [0.93, 0.21, 0.25];
	};
	if (percentage <= 40) {
		return [0.95, 0.68, 0.19];
	};

	return [0.34, 0.89, 0.54];
};

function normalizeName(name) {
	return String(name || '').trim().toLowerCase();
};

function bluezIconName(iconName) {
	if (!iconName) {
		return 'bluetooth-symbolic';
	};

	if (iconName === 'audio-headset') {
		return 'audio-headphones-symbolic';
	};

	return iconName.endsWith('-symbolic') ? iconName : `${iconName}-symbolic`;
};

function batteryLevelIcon(device) {
	if (device.state === UPOWER_STATE.FULLY_CHARGED) {
		return 'battery-level-100-charged-symbolic';
	};

	const level = Math.round(device.percentage / 10) * 10;
	const suffix = device.state === UPOWER_STATE.CHARGING ? '-charging' : '';

	return `battery-level-${level}${suffix}-symbolic`;
};

function iconForDevice(device) {
	if (!device) {
		return 'battery-missing-symbolic';
	};

	if (device.source === 'bluez' && device.iconName) {
		return device.iconName;
	};

	switch (device.kind) {
		case DEVICE_TYPE.BATTERY:
		case DEVICE_TYPE.COMPUTER:
			return device.powerSupply ? batteryLevelIcon(device) : 'battery-symbolic';
		case DEVICE_TYPE.MOUSE:
			return 'input-mouse-symbolic';
		case DEVICE_TYPE.GAMING_INPUT:
			return 'input-gaming-symbolic';
		case DEVICE_TYPE.KEYBOARD:
			return 'input-keyboard-symbolic';
		case DEVICE_TYPE.PHONE:
		case DEVICE_TYPE.PDA:
			return 'phone-symbolic';
		case DEVICE_TYPE.TABLET:
		case DEVICE_TYPE.PEN:
		case DEVICE_TYPE.TOUCHPAD:
			return 'input-tablet-symbolic';
		case DEVICE_TYPE.HEADSET:
		case DEVICE_TYPE.HEADPHONES:
		case DEVICE_TYPE.OTHER_AUDIO:
			return 'audio-headphones-symbolic';
		case DEVICE_TYPE.SPEAKERS:
			return 'audio-speakers-symbolic';
		case DEVICE_TYPE.UPS:
			return 'battery-symbolic';
		default:
			return device.iconName || 'battery-symbolic';
	};
};

function deviceName(props, kind) {
	const model = String(variantValue(props, 'Model', '')).trim();
	const vendor = String(variantValue(props, 'Vendor', '')).trim();

	if (model) {
		return model;
	};
	if (vendor) {
		return vendor;
	};
	if (kind === DEVICE_TYPE.BATTERY) {
		return 'Комп’ютер';
	};
	if (kind === DEVICE_TYPE.MOUSE) {
		return 'Миша';
	};
	if (kind === DEVICE_TYPE.KEYBOARD) {
		return 'Клавіатура';
	};

	return 'Пристрій';
};

function isBatteryLike(props) {
	const kind = variantValue(props, 'Type', 0);
	const percentage = Number(variantValue(props, 'Percentage', Number.NaN));
	const rechargeable = variantValue(props, 'IsRechargeable', false);
	const present = variantValue(props, 'IsPresent', true);

	if (!present || !Number.isFinite(percentage)) {
		return false;
	};

	return rechargeable || [
		DEVICE_TYPE.BATTERY,
		DEVICE_TYPE.UPS,
		DEVICE_TYPE.MOUSE,
		DEVICE_TYPE.KEYBOARD,
		DEVICE_TYPE.PDA,
		DEVICE_TYPE.PHONE,
		DEVICE_TYPE.MEDIA_PLAYER,
		DEVICE_TYPE.TABLET,
		DEVICE_TYPE.COMPUTER,
		DEVICE_TYPE.GAMING_INPUT,
		DEVICE_TYPE.PEN,
		DEVICE_TYPE.TOUCHPAD,
		DEVICE_TYPE.HEADSET,
		DEVICE_TYPE.SPEAKERS,
		DEVICE_TYPE.HEADPHONES,
		DEVICE_TYPE.OTHER_AUDIO,
	].includes(kind);
};

function systemCall(name, path, iface, method, params = null) {
	return Gio.DBus.system.call(
		name,
		path,
		iface,
		method,
		params,
		null,
		Gio.DBusCallFlags.NONE,
		DBUS_TIMEOUT_MS,
		null);
};

function upowerCall(path, iface, method, params = null) {
	return systemCall('org.freedesktop.UPower', path, iface, method, params);
};

async function readUPowerProps(path) {
	try {
		const [props] = (await upowerCall(
			path,
			'org.freedesktop.DBus.Properties',
			'GetAll',
			GLib.Variant.new('(s)', ['org.freedesktop.UPower.Device']))).deep_unpack();

		return props;
	} catch (error) {
		warn('upower-read-device', `Could not read UPower device ${path}: ${error.message}`);
		return null;
	};
};

async function readUPowerDevices() {
	try {
		const [paths] = (await upowerCall('/org/freedesktop/UPower', 'org.freedesktop.UPower', 'EnumerateDevices')).deep_unpack();
		const allProps = await Promise.all(paths.map(readUPowerProps));
		const devices = [];

		for (const props of allProps) {
			if (!props || !isBatteryLike(props)) {
				continue;
			};

			const kind = variantValue(props, 'Type', 0);
			const percentage = Math.round(Math.max(0, Math.min(100, Number(variantValue(props, 'Percentage', 0)))));

			devices.push({
				source: 'upower',
				name: deviceName(props, kind),
				kind,
				percentage,
				powerSupply: variantValue(props, 'PowerSupply', false),
				state: variantValue(props, 'State', 0),
				iconName: variantValue(props, 'IconName', null),
				nativePath: variantValue(props, 'NativePath', null),
			});
		};

		return devices;
	} catch (error) {
		warn('upower-read', `Could not read UPower batteries: ${error.message}`);
		return [];
	};
};

async function readBlueZDevices() {
	try {
		const [objects] = (await systemCall(
			'org.bluez',
			'/',
			'org.freedesktop.DBus.ObjectManager',
			'GetManagedObjects')).deep_unpack();
		const devices = [];

		for (const [path, interfaces] of Object.entries(objects)) {
			const deviceProps = interfaces['org.bluez.Device1'];
			const batteryProps = interfaces['org.bluez.Battery1'];

			if (!deviceProps || !batteryProps || !variantValue(deviceProps, 'Connected', false)) {
				continue;
			};

			const percentage = Number(variantValue(batteryProps, 'Percentage', Number.NaN));

			if (!Number.isFinite(percentage)) {
				continue;
			};

			const iconName = bluezIconName(variantValue(deviceProps, 'Icon', null));

			devices.push({
				source: 'bluez',
				name: String(variantValue(deviceProps, 'Alias', '') || variantValue(deviceProps, 'Name', '') || 'Bluetooth'),
				percentage: Math.round(Math.max(0, Math.min(100, percentage))),
				powerSupply: false,
				iconName,
				nativePath: path,
			});
		};

		return devices;
	} catch (error) {
		warn('bluez-read', `Could not read Bluetooth batteries: ${error.message}`);
		return [];
	};
};

function deviceKey(device) {
	const path = String(device.nativePath || '');

	if (path.startsWith('/org/bluez/')) {
		return path;
	};

	return normalizeName(device.name);
};

function mergeDevices(devices) {
	const merged = new Map();

	for (const device of devices) {
		const key = deviceKey(device);
		const existing = merged.get(key);

		if (!existing || (existing.source !== 'upower' && device.source === 'upower')) {
			merged.set(key, device);
		};
	};

	return [...merged.values()].sort((a, b) => Number(b.powerSupply) - Number(a.powerSupply) || a.name.localeCompare(b.name));
};

async function readDevices() {
	const [upowerDevices, bluezDevices] = await Promise.all([readUPowerDevices(), readBlueZDevices()]);

	return mergeDevices([...upowerDevices, ...bluezDevices]);
};

function devicesSignature(devices) {
	return JSON.stringify((devices ?? []).map(device => [
		device.name,
		device.kind,
		device.percentage,
		device.state,
		device.powerSupply,
		device.iconName,
	]));
};

// D-Bus reads are async so a slow UPower/BlueZ never blocks the shell.
// Renders use the cached list; overlapping requests collapse into one
// follow-up read, and views are rebuilt only when the devices changed.
function requestDevices() {
	if (readInFlight) {
		readPending = true;
		return;
	};

	readInFlight = true;
	readDevices().then(devices => {
		const changed = devicesSignature(devices) !== devicesSignature(cachedDevices);

		cachedDevices = devices;
		if (changed) {
			for (const [body, context] of liveBodies) {
				body.destroy_all_children();
				buildTray(body, context.theme, context.createLabel);
			};
		};
	}).catch(error => {
		warn('battery-read', `Could not read batteries: ${error.message}`);
	}).finally(() => {
		readInFlight = false;
		if (readPending) {
			readPending = false;
			requestDevices();
		};
	});
};

const BatteryRing = GObject.registerClass(
	class BatteryRing extends St.DrawingArea {
		_init(device, theme) {
			super._init({style_class: 'widget-battery-ring'});
			this._percentage = device?.percentage ?? null;
			this._ringColor = batteryColor(this._percentage);
			this._trackColor = theme?.dark ? [1, 1, 1, 0.16] : [0, 0, 0, 0.11];
		};

		vfunc_repaint() {
			const cr = this.get_context();
			const [width, height] = this.get_surface_size();

			if (width <= 0 || height <= 0) {
				cr.$dispose();
				return;
			};

			const lineWidth = 7;
			const radius = Math.min(width, height) / 2 - lineWidth / 2 - 1;
			const centerX = width / 2;
			const centerY = height / 2;

			cr.setLineCap(1);
			cr.setLineWidth(lineWidth);
			cr.arc(centerX, centerY, radius, 0, Math.PI * 2);
			cr.setSourceRGBA(...this._trackColor);
			cr.stroke();

			if (Number.isFinite(this._percentage)) {
				cr.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (this._percentage / 100));
				cr.setSourceRGBA(...this._ringColor, 1);
				cr.stroke();
			};

			cr.$dispose();
		};
	});

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

function createSlot(device, theme, createLabel) {
	const slot = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-battery-slot',
		x_expand: false,
		x_align: Clutter.ActorAlign.CENTER,
	});
	const gauge = new St.Widget({style_class: 'widget-battery-gauge'});
	const ring = new BatteryRing(device, theme);
	const icon = new St.Icon({
		icon_name: iconForDevice(device),
		style_class: 'widget-battery-icon',
		style: `color: ${device ? theme.text : theme.muted};`,
	});

	gauge.set_size(84, 84);
	ring.set_size(84, 84);
	icon.set_size(30, 30);
	icon.set_position(27, 27);
	gauge.add_child(ring);
	gauge.add_child(icon);
	slot.add_child(gauge);

	const label = createLabel(device ? `${device.percentage}%` : '', 'widget-battery-percent', `color: ${device ? theme.text : theme.muted};`);

	label.x_expand = false;
	label.x_align = Clutter.ActorAlign.CENTER;
	slot.add_child(label);
	return slot;
};

function buildTray(body, theme, createLabel) {
	const devices = (cachedDevices ?? []).slice(0, SLOT_COUNT);
	const tray = new St.BoxLayout({
		style_class: 'widget-battery-tray',
		x_expand: true,
		y_expand: true,
		x_align: Clutter.ActorAlign.CENTER,
		y_align: Clutter.ActorAlign.CENTER,
	});

	if (devices.length === 0) {
		tray.add_child(createSlot(null, theme, createLabel));
	};

	for (const device of devices) {
		tray.add_child(createSlot(device, theme, createLabel));
	};

	body.add_child(tray);
};

export function render({body, createLabel, theme}) {
	if (!liveBodies.has(body)) {
		body.connect('destroy', () => liveBodies.delete(body));
	};

	liveBodies.set(body, {theme, createLabel});
	buildTray(body, theme, createLabel);
	requestDevices();
};
