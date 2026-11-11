import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USER_AGENT = 'widgets-uk GNOME Shell extension (https://github.com/stonef1st/widgets)';

export function createSession() {
	return new Soup.Session({
		timeout: 20,
		user_agent: USER_AGENT,
	});
};

export class HttpError extends Error {
	constructor(status, url) {
		super(`HTTP ${status} for ${url}`);
		this.status = status;
	};
};

export async function fetchBytes(session, url, cancellable = null) {
	const message = Soup.Message.new('GET', url);
	const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
	const status = message.get_status();

	if (status !== Soup.Status.OK) {
		throw new HttpError(status, url);
	};

	return bytes;
};

// GET, or a form POST when `form` is given.
export async function fetchText(session, url, cancellable = null, {form = null} = {}) {
	const message = Soup.Message.new(form ? 'POST' : 'GET', url);

	if (form) {
		const body = Object.entries(form)
			.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
			.join('&');

		message.set_request_body_from_bytes('application/x-www-form-urlencoded', new GLib.Bytes(new TextEncoder().encode(body)));
	};

	const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
	const status = message.get_status();

	if (status !== Soup.Status.OK) {
		throw new HttpError(status, url);
	};

	return new TextDecoder().decode(bytes.get_data());
};

export async function fetchJson(session, url, cancellable = null, headers = {}) {
	const message = Soup.Message.new('GET', url);

	for (const [name, value] of Object.entries(headers)) {
		message.get_request_headers().append(name, value);
	};

	const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
	const status = message.get_status();

	if (status !== Soup.Status.OK) {
		throw new HttpError(status, url);
	};

	return JSON.parse(new TextDecoder().decode(bytes.get_data()));
};
