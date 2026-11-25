// Optional glass look for widget cards. Widgets sit under the windows, so only
// the wallpaper is ever behind them: each card blurs its own copy of it instead
// of reading the stage. The wallpaper part follows BlurredSurface in upstream's
// desktop/surface.js.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUR_RADIUS = 36;
// Matches border-radius of .widget.
const CARD_RADIUS = 26;
const TINTS = {
  dark: [0.07, 0.07, 0.09, 0.46],
  light: [1.0, 1.0, 1.0, 0.56],
};
// Danger glass (air alert, no power) is the wallpaper's brightness painted in
// one color: mixing red into a colored wallpaper turned it brown on green and
// purple on blue. Red keeps white text readable; yellow (the lower alert
// level) carries dark text.
const DANGER_TONES = {
  red: {shadow: [0.28, 0.02, 0.05], light: [0.98, 0.20, 0.24]},
  yellow: {shadow: [0.72, 0.50, 0.03], light: [1.0, 0.86, 0.24]},
};
const DANGER_EASE_MS = 300;

const DECLARATIONS = `
uniform float width;
uniform float height;
uniform float radius;
uniform vec4 tint;
uniform float danger;
uniform vec3 danger_shadow;
uniform vec3 danger_light;
`;

// Runs after Cogl has sampled the blurred card into cogl_color_out.
const CODE = `
vec2 size = vec2(width, height);
vec2 point = cogl_tex_coord_in[0].st * size;
vec2 centered = point - size * 0.5;
vec2 corner = abs(centered) - (size * 0.5 - vec2(radius));
float edge = length(max(corner, vec2(0.0))) + min(max(corner.x, corner.y), 0.0) - radius;
float coverage = 1.0 - smoothstep(-0.75, 0.0, edge);

vec2 normal = corner.x > 0.0 && corner.y > 0.0
  ? normalize(corner)
  : (corner.x > corner.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
normal *= sign(centered);
float facing = dot(normal, normalize(vec2(-0.5, -0.85)));
float band = 1.0 - smoothstep(0.0, 2.5, -edge);
float rim = band * (0.12 + 0.62 * pow(max(facing, 0.0), 2.0) + 0.28 * pow(max(-facing, 0.0), 2.0));
float sheen = 0.09 * pow(1.0 - clamp(point.y / height, 0.0, 1.0), 3.0);

vec3 color = cogl_color_out.rgb;
float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
color = clamp(mix(vec3(luma), color, 1.25), 0.0, 1.0);
color = mix(color, tint.rgb, tint.a);
color = mix(color, mix(danger_shadow, danger_light, luma), danger);
color += (1.0 - color) * clamp(rim + sheen, 0.0, 1.0);
cogl_color_out = vec4(color * coverage, coverage);
`;

const GlassEffect = GObject.registerClass({
  Properties: {
    // Eased through '@effects.glass.danger', so it is a GObject property.
    'danger': GObject.ParamSpec.double(
      'danger', null, null,
      GObject.ParamFlags.READWRITE,
      0, 1, 0
    ),
  },
},
  class GlassEffect extends Shell.GLSLEffect {
    _init(tint) {
      super._init({name: 'glass'});
      this._danger = 0;
      this._widthLocation = this.get_uniform_location('width');
      this._heightLocation = this.get_uniform_location('height');
      this._dangerLocation = this.get_uniform_location('danger');
      this._shadowLocation = this.get_uniform_location('danger_shadow');
      this._lightLocation = this.get_uniform_location('danger_light');
      this.set_uniform_float(this.get_uniform_location('radius'), 1, [CARD_RADIUS]);
      this.set_uniform_float(this.get_uniform_location('tint'), 4, tint);
      this.set_uniform_float(this._dangerLocation, 1, [0]);
      this.setTone('red');
    };

    setTone(tone) {
      const colors = DANGER_TONES[tone] ?? DANGER_TONES.red;

      if (this._tone === tone) {
        return;
      };

      this._tone = tone;
      this.set_uniform_float(this._shadowLocation, 3, colors.shadow);
      this.set_uniform_float(this._lightLocation, 3, colors.light);
      this.queue_repaint();
    };

    get danger() {
      return this._danger;
    };

    set danger(value) {
      if (this._danger === value) {
        return;
      };

      this._danger = value;
      this.set_uniform_float(this._dangerLocation, 1, [value]);
      this.queue_repaint();
      this.notify('danger');
    };

    vfunc_build_pipeline() {
      this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    };

    setSize(width, height) {
      this.set_uniform_float(this._widthLocation, 1, [width]);
      this.set_uniform_float(this._heightLocation, 1, [height]);
    };
  }
);

function createSurface(owner, monitor, dark) {
  const surface = new St.Widget({
    layout_manager: new Clutter.FixedLayout(),
    clip_to_allocation: true,
  });
  const wallpaper = new St.Widget({width: monitor.width, height: monitor.height});
  const manager = new Background.BackgroundManager({
    container: wallpaper,
    monitorIndex: Main.layoutManager.primaryIndex,
    controlPosition: false,
  });
  const glass = new GlassEffect(dark ? TINTS.dark : TINTS.light);
  const syncPosition = () => wallpaper.set_position(-owner.x, -owner.y);
  const syncSize = () => glass.setSize(Math.max(1, owner.width), Math.max(1, owner.height));

  surface.add_child(wallpaper);
  // The effect added first runs last: glass has to be drawn over the blur, not blurred with it.
  surface.add_effect(glass);
  surface.add_effect(new Shell.BlurEffect({
    brightness: 1,
    radius: BLUR_RADIUS,
    mode: Shell.BlurMode.ACTOR,
  }));

  owner.connectObject(
    'notify::x', syncPosition,
    'notify::y', syncPosition,
    'notify::width', syncSize,
    'notify::height', syncSize,
    surface
  );
  surface.connect('destroy', () => manager.destroy());

  return {surface, glass};
};

// Glass cards by their card, for setGlassDanger().
const glassCards = new WeakMap();

// Returns the actor to place on the desktop: the glass with the card on top.
// The card keeps its style, but its own background has to be transparent.
export function wrapInGlass(card, dark) {
  const actor = new St.Widget({
    layout_manager: new Clutter.FixedLayout(),
    reactive: true,
    can_focus: true,
    track_hover: true,
  });
  const monitor = Main.layoutManager.primaryMonitor;
  const addFilling = child => {
    child.add_constraint(new Clutter.BindConstraint({
      source: actor,
      coordinate: Clutter.BindCoordinate.SIZE,
    }));
    actor.add_child(child);
  };

  if (monitor) {
    const {surface, glass} = createSurface(actor, monitor, dark);

    addFilling(surface);
    glassCards.set(card, {surface, glass});
  };

  addFilling(card);

  return actor;
};

// Turns the danger glass on in a tone ('red', 'yellow') or off (null). Returns
// false for a card without glass, which has to show danger with its own style.
export function setGlassDanger(card, tone) {
  const entry = glassCards.get(card);

  if (!entry) {
    return false;
  };

  const target = tone ? 1 : 0;
  const {surface, glass} = entry;

  // Off keeps the last tone, so the fade out stays in its color.
  if (tone) {
    glass.setTone(tone);
  };

  if (glass.danger !== target) {
    surface.remove_transition('@effects.glass.danger');
    surface.ease_property('@effects.glass.danger', target, {
      duration: DANGER_EASE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  };

  return true;
};
