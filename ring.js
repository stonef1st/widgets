import GObject from 'gi://GObject';
import St from 'gi://St';

// Shared progress ring used by the battery and Claude usage widgets.

export const RING_COLORS = {
	green: '#57e389',
	yellow: '#f2ad30',
	red: '#ed3540',
};

function hexToRgb(hex) {
	const value = parseInt(String(hex).replace('#', ''), 16);

	return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
};

export const ProgressRing = GObject.registerClass(
	class ProgressRing extends St.DrawingArea {
		_init(percentage, color, theme) {
			super._init({style_class: 'widget-ring'});
			this._percentage = percentage;
			this._ringColor = hexToRgb(color);
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

			if (Number.isFinite(this._percentage) && this._percentage > 0) {
				cr.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (Math.min(this._percentage, 100) / 100));
				cr.setSourceRGBA(...this._ringColor, 1);
				cr.stroke();
			};

			cr.$dispose();
		};
	});
