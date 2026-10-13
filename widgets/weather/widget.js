import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GWeather from 'gi://GWeather';
import St from 'gi://St';

import { warn } from '../../logger.js';
import { _, format, language } from '../../i18n.js';

export const type = 'weather';
export const label = 'Weather';
export const stylesheet = 'widgets/weather/stylesheet.css';
export const appIds = ['org.gnome.Weather.desktop'];
export const settingsSchema = 'org.gnome.Weather';
export const cacheTtlMs = 10 * 60 * 1000;
export const defaultSize = 'small';

export function style(theme) {
	return `background-color: ${theme.background}; border-color: ${theme.border}; color: ${theme.text};`;
};

export function locationNameFromSettings(settings) {
	const strings = locationStringsFromSettings(settings);

	return strings[0] || null;
};

function locationStringsFromSettings(settings) {
	if (!settings) {
		return [];
	};

	const locations = settings.get_value('locations');

	if (locations.n_children() === 0) {
		return [];
	};

	const serialized = locations.get_child_value(0).print(true);

	return [...serialized.matchAll(/'([^']*)'/g)].map(match => match[1]);
};

export function locationFromSettings(settings) {
	if (!settings) {
		return null;
	};

	try {
		const locations = settings.get_value('locations');

		return locations.n_children() > 0
			? GWeather.Location.get_world()?.deserialize(locations.get_child_value(0).deep_unpack()) ?? null
			: null;
	} catch (error) {
		warn('weather-location-deserialize', `Could not deserialize Weather app location: ${error.message}`);
		return null;
	};
};

export function infoForLocation(location) {
	const info = GWeather.Info.new(location);

	info.set_application_id('com.github.TheRealSourcer.Widgets');
	info.set_contact_info('https://github.com/TheRealSourcer/widgets');
	info.set_enabled_providers(
		GWeather.Provider.METAR |
		GWeather.Provider.MET_NO |
		GWeather.Provider.OWM);
	return info;
};

export function weatherFromInfo(info, location, displayName = null) {
	const currentInfo = currentConditionsInfo(info);
	const locationName = currentInfo.get_location_name();
	const apparent = formatTemperature(currentInfo.get_apparent());
	// Current observations may have a temperature but no sky/conditions;
	// take text and icon from the nearest forecast together so they match.
	const describedInfo = hasDescription(currentInfo) ? currentInfo : currentForecastInfo(info);
	const summary = language() === 'uk' ? ukrainianSummary(describedInfo) : null;

	return {
		temp: formatTemperature(currentInfo.get_temp()),
		summary: summary ?? cleanSummary(describedInfo.get_weather_summary(), locationName),
		location: displayName || location.get_city_name() || locationName,
		icon: describedInfo.get_icon_name() || 'weather-clear',
		feelsLike: apparent && apparent !== '--' ? format(_('Feels like %s'), apparent) : null,
	};
};

function hasDescription(info) {
	const [hasConditions, phenomenon] = info.get_value_conditions();
	const [hasSky] = info.get_value_sky();

	return hasSky || (hasConditions && phenomenon !== GWeather.ConditionPhenomenon.NONE);
};

// libgweather translates by the session locale, which may differ from the
// widget language, so Ukrainian condition text is built from the raw
// sky/phenomenon values. Ukrainian grammar does not fit plain .po strings.
// Gender: m, f, n or p (plural) — adjectives must agree with the noun.
const SKY_TEXT = {
	[GWeather.Sky.CLEAR]: 'Ясно',
	[GWeather.Sky.FEW]: 'Малохмарно',
	[GWeather.Sky.SCATTERED]: 'Мінлива хмарність',
	[GWeather.Sky.BROKEN]: 'Хмарно',
	[GWeather.Sky.OVERCAST]: 'Похмуро',
};

const PHENOMENON_TEXT = {
	[GWeather.ConditionPhenomenon.DRIZZLE]: ['мряка', 'f'],
	[GWeather.ConditionPhenomenon.RAIN]: ['дощ', 'm'],
	[GWeather.ConditionPhenomenon.SNOW]: ['сніг', 'm'],
	[GWeather.ConditionPhenomenon.SNOW_GRAINS]: ['снігова крупа', 'f'],
	[GWeather.ConditionPhenomenon.ICE_CRYSTALS]: ['крижані голки', 'p'],
	[GWeather.ConditionPhenomenon.ICE_PELLETS]: ['крижана крупа', 'f'],
	[GWeather.ConditionPhenomenon.HAIL]: ['град', 'm'],
	[GWeather.ConditionPhenomenon.SMALL_HAIL]: ['дрібний град', 'm'],
	[GWeather.ConditionPhenomenon.UNKNOWN_PRECIPITATION]: ['опади', 'p'],
	[GWeather.ConditionPhenomenon.MIST]: ['серпанок', 'm'],
	[GWeather.ConditionPhenomenon.FOG]: ['туман', 'm'],
	[GWeather.ConditionPhenomenon.SMOKE]: ['дим', 'm'],
	[GWeather.ConditionPhenomenon.VOLCANIC_ASH]: ['вулканічний попіл', 'm'],
	[GWeather.ConditionPhenomenon.SAND]: ['пісок', 'm'],
	[GWeather.ConditionPhenomenon.HAZE]: ['імла', 'f'],
	[GWeather.ConditionPhenomenon.SPRAY]: ['бризки', 'p'],
	[GWeather.ConditionPhenomenon.DUST]: ['пил', 'm'],
	[GWeather.ConditionPhenomenon.SQUALL]: ['шквал', 'm'],
	[GWeather.ConditionPhenomenon.SANDSTORM]: ['піщана буря', 'f'],
	[GWeather.ConditionPhenomenon.DUSTSTORM]: ['пилова буря', 'f'],
	[GWeather.ConditionPhenomenon.FUNNEL_CLOUD]: ['лійкова хмара', 'f'],
	[GWeather.ConditionPhenomenon.TORNADO]: ['торнадо', 'n'],
	[GWeather.ConditionPhenomenon.DUST_WHIRLS]: ['пилові вихори', 'p'],
};

const QUALIFIER_ADJECTIVE = {
	[GWeather.ConditionQualifier.LIGHT]: {m: 'слабкий', f: 'слабка', n: 'слабке', p: 'слабкі'},
	[GWeather.ConditionQualifier.MODERATE]: {m: 'помірний', f: 'помірна', n: 'помірне', p: 'помірні'},
	[GWeather.ConditionQualifier.HEAVY]: {m: 'сильний', f: 'сильна', n: 'сильне', p: 'сильні'},
	[GWeather.ConditionQualifier.SHOWERS]: {m: 'короткочасний', f: 'короткочасна', n: 'короткочасне', p: 'короткочасні'},
	[GWeather.ConditionQualifier.FREEZING]: {m: 'крижаний', f: 'крижана', n: 'крижане', p: 'крижані'},
	[GWeather.ConditionQualifier.SHALLOW]: {m: 'приземний', f: 'приземна', n: 'приземне', p: 'приземні'},
};

function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
};

function conditionText(phenomenon, qualifier) {
	const entry = PHENOMENON_TEXT[phenomenon];

	if (!entry) {
		return null;
	};

	const [noun, gender] = entry;
	const adjective = QUALIFIER_ADJECTIVE[qualifier]?.[gender];

	if (adjective) {
		return capitalize(`${adjective} ${noun}`);
	};

	switch (qualifier) {
		case GWeather.ConditionQualifier.THUNDERSTORM:
			return `Гроза, ${noun}`;
		case GWeather.ConditionQualifier.VICINITY:
			return capitalize(`${noun} поблизу`);
		case GWeather.ConditionQualifier.PATCHES:
		case GWeather.ConditionQualifier.PARTIAL:
			return `Місцями ${noun}`;
		case GWeather.ConditionQualifier.BLOWING:
			return phenomenon === GWeather.ConditionPhenomenon.SNOW ? 'Заметіль' : capitalize(`${noun} з вітром`);
		case GWeather.ConditionQualifier.DRIFTING:
			return phenomenon === GWeather.ConditionPhenomenon.SNOW ? 'Поземок' : capitalize(`${noun} з вітром`);
		default:
			return capitalize(noun);
	};
};

function ukrainianSummary(info) {
	const [hasConditions, phenomenon, qualifier] = info.get_value_conditions();

	if (hasConditions) {
		const text = conditionText(phenomenon, qualifier);

		if (text) {
			return text;
		};
	};

	const [hasSky, sky] = info.get_value_sky();

	return hasSky ? SKY_TEXT[sky] ?? null : null;
};

function currentConditionsInfo(info) {
	return formatTemperature(info.get_temp()) !== '--' ? info : currentForecastInfo(info);
};

function forecastUpdateTime(info) {
	const [ok, updateTime] = info.get_value_update();

	return ok ? updateTime : null;
};

function currentForecastInfo(info) {
	const forecasts = info.get_forecast_list() ?? [];
	const now = Math.floor(Date.now() / 1000);
	let bestPast = null;
	let bestFuture = null;

	for (const forecast of forecasts) {
		const updateTime = forecastUpdateTime(forecast);
		const temp = formatTemperature(forecast.get_temp());

		if (updateTime === null || temp === '--') {
			continue;
		};

		if (updateTime <= now && (!bestPast || updateTime > bestPast.updateTime)) {
			bestPast = {forecast, updateTime};
		} else if (updateTime > now && (!bestFuture || updateTime < bestFuture.updateTime)) {
			bestFuture = {forecast, updateTime};
		};
	};

	return bestPast?.forecast ?? bestFuture?.forecast ?? info;
};

function formatTemperature(temperature) {
	const text = String(temperature ?? '--').trim();
	const match = text.match(/-?\d+(?:[.,]\d+)?/);

	if (!match) {
		return '--';
	};

	const value = Number(match[0].replace(',', '.'));

	return Number.isFinite(value) ? `${Math.round(value)}°` : '--';
};

function cleanSummary(summary, locationName) {
	if (!summary) {
		return _('Weather unavailable');
	};

	if (locationName && summary.startsWith(`${locationName}: `)) {
		return summary.slice(locationName.length + 2);
	};

	const separator = summary.indexOf(': ');

	return separator >= 0 ? summary.slice(separator + 2) : summary;
};

function fallbackIcon(text) {
	const lower = String(text || '').toLowerCase();

	if (lower.includes('thunder') || lower.includes('storm')) {
		return 'weather-storm';
	};
	if (lower.includes('snow') || lower.includes('ice')) {
		return 'weather-snow';
	};
	if (lower.includes('rain') || lower.includes('shower') || lower.includes('drizzle')) {
		return 'weather-showers';
	};
	if (lower.includes('fog') || lower.includes('mist') || lower.includes('haze')) {
		return 'weather-fog';
	};
	if (lower.includes('cloud') || lower.includes('overcast')) {
		return 'weather-few-clouds';
	};

	return 'weather-clear';
};

function fullColorWeatherIcon(iconName) {
	const baseName = String(iconName || 'weather-clear')
		.replace(/-symbolic$/, '')
		.replace(/-(small|large)$/, '');
	const candidates = [
		`${baseName}-large.svg`,
		`${baseName}-small.svg`,
		`${baseName}.svg`,
	];

	for (const candidate of candidates) {
		const path = GLib.build_filenamev(['/usr/share/icons/hicolor/scalable/status', candidate]);
		const file = Gio.File.new_for_path(path);

		if (file.query_exists(null)) {
			return Gio.FileIcon.new(file);
		};
	};

	return null;
};

export function render({body, widget, createLabel, theme, weather, weatherLocation}) {
	const detail = widget.data.detail || _('Weather unavailable');
	const renderedWeather = weather ?? {
		temp: formatTemperature(String(detail).split(/\s+/)[0] || '--'),
		summary: String(detail).replace(/^\S+\s*/, '') || _('Open Weather to set a location'),
		location: weatherLocation || widget.data.location || 'GNOME Weather',
		icon: fallbackIcon(detail),
		feelsLike: null,
	};
	const locationRow = new St.BoxLayout({
		style_class: 'widget-weather-location-row',
		x_align: Clutter.ActorAlign.START,
	});
	const locationIcon = new St.Icon({
		icon_name: 'find-location-symbolic',
		style_class: 'widget-weather-location-icon',
		style: `color: ${theme.muted};`,
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	});
	const locationLabel = createLabel(
		renderedWeather.location,
		'widget-weather-location-name',
		`color: ${theme.muted};`);
	const bottomRow = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-weather-bottom',
		x_expand: true,
		x_align: Clutter.ActorAlign.START,
	});
	const iconParams = {
		style_class: 'widget-weather-icon',
		style: 'icon-shadow: 0 2px 4px rgba(0, 0, 0, 0.42);',
		x_align: Clutter.ActorAlign.START,
		y_align: Clutter.ActorAlign.CENTER,
	};
	const gicon = fullColorWeatherIcon(renderedWeather.icon);

	if (gicon) {
		iconParams.gicon = gicon;
	} else {
		iconParams.icon_name = renderedWeather.icon;
	};

	const icon = new St.Icon(iconParams);
	const details = new St.BoxLayout({
		orientation: Clutter.Orientation.VERTICAL,
		style_class: 'widget-weather-details',
		x_align: Clutter.ActorAlign.START,
	});

	locationLabel.x_expand = false;
	locationRow.add_child(locationLabel);
	locationRow.add_child(locationIcon);
	body.add_child(locationRow);
	body.add_child(createLabel(renderedWeather.temp, 'widget-weather-temp', `color: ${theme.text};`));
	body.add_child(new St.Widget({y_expand: true}));

	details.add_child(createLabel(renderedWeather.summary, 'widget-weather-summary', `color: ${theme.text};`));
	if (renderedWeather.feelsLike) {
		details.add_child(createLabel(renderedWeather.feelsLike, 'widget-weather-feels-like', `color: ${theme.muted};`));
	};

	bottomRow.add_child(icon);
	bottomRow.add_child(details);
	body.add_child(bottomRow);
};
