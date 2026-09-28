# Linux Setup

Linux is a first-class citizen (spec §7): X11 and Wayland get separate
backends, and the Wayland security model is respected — the adapter
reports `restricted` instead of pretending.

## Requirements

- Node.js ≥ 20
- X11 session (Xorg) **or** Wayland with the tools below
- Tool availability is probed at startup; missing tools lower the
  capability matrix honestly

## X11 (recommended for automation)

```bash
# Debian/Ubuntu
sudo apt install xdotool wmctrl imagemagick xclip python3-pip
pip3 install pyatspi          # AT-SPI structured tree (accessibility)

# Fedora
sudo dnf install xdotool wmctrl ImageMagick xclip
pip3 install pyatspi
```

| Tool | Enables |
|---|---|
| `xdotool` | global input (mouse/keyboard/scroll/drag), key combos |
| `wmctrl` | window list/focus/close |
| `import` / `scrot` / `gnome-screenshot` | screenshots (probed in that order) |
| `pyatspi` | AT-SPI accessibility tree + semantic actions (doAction/setTextContents) |
| `xclip` / `xsel` | clipboard |

Session detection: `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`. Coordinates
are physical pixels (scale 1); **fractional scaling is not modeled on X11
— noted in `capabilities.notes`**.

## Wayland

Wayland deliberately denies global screenshot/input to arbitrary clients.
The adapter supports what the compositor actually allows:

| Tool | Enables |
|---|---|
| `grim` (wlroots family: Sway, Hyprland…) | screenshots (region via `-g`) |
| `wtype` | keyboard input |
| `ydotool` + `ydotoold` (uinput perms) | pointer input |
| `wl-copy` | clipboard |
| `pyatspi` | AT-SPI tree + semantic actions (works on GNOME/KDE via a11y bus) |

When a capability is missing you get `restricted` with actionable hints
(e.g. the xdg-desktop-portal Screenshot interface requires interactive
user consent — the adapter will not fake it).

## Desktop environments

GNOME / KDE Plasma / XFCE work through the shared X11/Wayland backends +
AT-SPI. AT-SPI requires the accessibility bus; on GNOME enable it in
Settings → Accessibility (or it activates on demand when `pyatspi`
connects).

## Verify

There is no hermetic Linux E2E on other hosts (by design). On a Linux box:

```bash
pnpm test && node -e "
import('./dist/index.js').catch(()=>{});
" # then over MCP:
# computer_list_targets → linux target available? capabilities.notes?
```

The capability JSON tells you exactly which tools were found; anything
missing is stated with the reason.
