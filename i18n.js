import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Translations live in locale/<lang>.po and are parsed here instead of
// going through gettext: gettext follows the session locale, while the
// widget language is a setting of its own (the session may stay en_US).

const LOCALE_DIR = GLib.build_filenamev([
	GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
	'locale',
]);
const INTL_LOCALES = {
	uk: 'uk-UA',
};

let currentLanguage = 'en';
let catalog = new Map();

function unquote(text) {
	return JSON.parse(text.trim());
};

function parsePo(contents) {
	const entries = new Map();
	let msgid = null;
	let msgstr = null;
	let field = null;

	const flush = () => {
		if (msgid && msgstr) {
			entries.set(msgid, msgstr);
		};

		msgid = null;
		msgstr = null;
		field = null;
	};

	for (const rawLine of contents.split('\n')) {
		const line = rawLine.trim();

		if (line.startsWith('msgid ')) {
			flush();
			msgid = unquote(line.slice(6));
			field = 'msgid';
		} else if (line.startsWith('msgstr ')) {
			msgstr = unquote(line.slice(7));
			field = 'msgstr';
		} else if (line.startsWith('"') && field === 'msgid') {
			msgid += unquote(line);
		} else if (line.startsWith('"') && field === 'msgstr') {
			msgstr += unquote(line);
		} else if (line === '' || line.startsWith('#')) {
			field = line === '' ? null : field;
		};
	};

	flush();
	return entries;
};

function loadCatalog(language) {
	const file = Gio.File.new_for_path(GLib.build_filenamev([LOCALE_DIR, `${language}.po`]));

	try {
		const [, bytes] = file.load_contents(null);

		return parsePo(new TextDecoder().decode(bytes));
	} catch {
		return null;
	};
};

export function availableLanguages() {
	const languages = ['en'];

	try {
		const enumerator = Gio.File.new_for_path(LOCALE_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
		let info;

		while ((info = enumerator.next_file(null))) {
			const name = info.get_name();

			if (name.endsWith('.po')) {
				languages.push(name.slice(0, -3));
			};
		};
	} catch {
		// No locale directory: English only.
	};

	return languages;
};

function resolveLanguage(setting) {
	const available = availableLanguages();

	if (setting && setting !== 'auto') {
		return available.includes(setting) ? setting : 'en';
	};

	for (const name of GLib.get_language_names()) {
		const base = name.split(/[_.@]/)[0];

		if (available.includes(base)) {
			return base;
		};
	};

	return 'en';
};

export function setLanguage(setting) {
	currentLanguage = resolveLanguage(setting);
	catalog = currentLanguage === 'en' ? new Map() : loadCatalog(currentLanguage) ?? new Map();
};

export function language() {
	return currentLanguage;
};

// Locale for Intl/Date formatting; undefined falls back to the session locale.
export function intlLocale() {
	return INTL_LOCALES[currentLanguage];
};

export function _(msgid) {
	return catalog.get(msgid) ?? msgid;
};

export function format(template, ...values) {
	let index = 0;

	return template.replace(/%s/g, () => String(values[index++] ?? ''));
};
