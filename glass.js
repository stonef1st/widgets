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

const DECLARATIONS = `
uniform float width;
uniform float height;
uniform float radius;
uniform vec4 tint;
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
color = clamp(mix(vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), color, 1.25), 0.0, 1.0);
color = mix(color, tint.rgb, tint.a);
color += (1.0 - color) * clamp(rim + sheen, 0.0, 1.0);
cogl_color_out = vec4(color * coverage, coverage);
`;

const GlassEffect = GObject.registerClass(
  class GlassEffect extends Shell.GLSLEffect {
    _init(tint) {
      super._init();
      this._widthLocation = this.get_uniform_location('width');
      this._heightLocation = this.get_uniform_location('height');
      this.set_uniform_float(this.get_uniform_location('radius'), 1, [CARD_RADIUS]);
      this.set_uniform_float(this.get_uniform_location('tint'), 4, tint);
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

  return surface;
};

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
    addFilling(createSurface(actor, monitor, dark));
  };

  addFilling(card);

  return actor;
};
