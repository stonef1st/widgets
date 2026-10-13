> **Personal fork** of [TheRealSourcer/widgets](https://github.com/TheRealSourcer/widgets).
> Installs side by side with the original under its own uuid `widgets-uk@stonef1st`,
> so extensions.gnome.org updates never overwrite it.
>
> Changes on top of upstream:
>
> - Preferences window: language, first day of week, calendar events,
>   alert region, power outage group.
> - Translations in `locale/<lang>.po`, chosen in preferences independently
>   of the session locale (Ukrainian included).
> - Calendar: events from the top bar calendars (dots under days, upcoming
>   list on a wide calendar), configurable first day of week.
> - Edit mode: size button (small → medium → large).
> - New optional widgets: air raid alerts (siren.pp.ua / ukrainealarm.com,
>   with notifications) and power outage schedule
>   ([OE_OUTAGE_DATA](https://github.com/yaroslav2901/OE_OUTAGE_DATA)).
> - Battery widget: async D-Bus reads, only connected devices, level icon for
>   the laptop battery, headphones and gamepad icons.
> - Weather: icon matches the text when only forecast data has sky info.
>
> Install:
>
> ```bash
> git clone https://github.com/stonef1st/widgets.git \
>   ~/.local/share/gnome-shell/extensions/widgets-uk@stonef1st
> gnome-extensions disable widgets@distro.com   # if the original is installed
> ```
>
> Log out and back in (Wayland), then enable "Widgets (UA)" in the Extensions app.
> Both versions share one settings schema, so enable only one of them.
>
> Pull upstream changes: `git fetch upstream && git merge upstream/main`.

**This GitHub repo (<https://github.com/TheRealSourcer/widgets>) is the official
source for the project. Do not download releases from unverified sources.**

# Widgets (V0.2.3)

<img src="./icon.svg" width="128" height="128" alt="widgets-icon" align="right" onerror="this.style.display='none'"/>

This is a GNOME Shell extension that provides gnome-themed widgets to your desktop.

<img src="./showcase.png" alt="widgets-showcase" align="center" onerror="this.style.display='none'"/>

It focuses on:

 - **integration**: easy access in GNOME top panel and incorporation with the GNOME ecosystem.
 - **style**: tightly follows GNOME Shell theme and styling.
 - **freedom**: free, unencumbered software released into the public domain

Its features include:

- **Clock**: an analog clock that updates in real time.
- **Calendar**: a compact monthly calendar with one-click access to GNOME Calendar.
- **Weather**: current conditions, temperature, and feels-like information using your GNOME Weather location.
- **Photos**: a cover-style photo widget that displays pictures from your Camera, Screenshots, and Downloads folders.
- **Battery**: battery levels for the computer and connected Bluetooth devices, with support for up to four devices.

## Prerequisites

1. **GNOME Shell:** Version 48, 49, 50 or 51.

## Get the extension

 - **GNOME Extensions Website:** [Download from extensions.gnome.org] *https://extensions.gnome.org/extension/10607/widgets/*
 - **Manual Installation:**
   ```bash
   git clone [https://github.com/TheRealSourcer/widgets.git](https://github.com/TheRealSourcer/widgets.git)
   # Copy the extension folder to your local GNOME extensions directory
   cp -r widgets@distro.com ~/.local/share/gnome-shell/extensions/
   ```
   *Note: Remember to restart GNOME Shell and enable the extension via the "Extensions" app.*

## Resources

 - [GNOME Extensions Guide](https://gjs.guide/extensions/) - For GNOME extension environments.

## Contact

You can open an [issue] for bug reports, feature requests, or general questions regarding the GNOME extension.

[issue]: https://github.com/TheRealSourcer/widgets/issues

## License

    This is free and unencumbered software released into the public domain.
    
    Anyone is free to copy, modify, publish, use, compile, sell, or
    distribute this software, either in source code form or as a compiled
    binary, for any purpose, commercial or non-commercial, and by any
    means.
    
    In jurisdictions that recognize copyright laws, the author or authors
    of this software dedicate any and all copyright interest in the
    software to the public domain. We make this dedication for the benefit
    of the public at large and to the detriment of our heirs and
    successors. We intend this dedication to be an overt act of
    relinquishment in perpetuity of all present and future rights to this
    software under copyright law.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
    EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
    IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
    OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
    ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
    OTHER DEALINGS IN THE SOFTWARE.
    
    For more information, please refer to <https://unlicense.org>
