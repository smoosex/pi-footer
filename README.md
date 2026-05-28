# pi-footer

[中文](./README.zh-CN.md) | English

A compact footer/status bar extension for [pi](https://github.com/earendil-works/pi) coding agent.

This plugin is a simplified take on [`nicobailon/pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer), with a smaller configuration model plus a few extra features such as custom segment ordering, custom extension-status items, rainbow coloring, and a prompted input editor.

## Features

- Powerline-style footer segments
- Presets for different levels of detail
- Fully custom segment order via `footer.segments`
- Custom items sourced from extension statuses
- `rainbow` color support for custom items
- Responsive overflow: segments that do not fit on the first footer line move to the next line
- Input editor polish:
  - left/right outer margin
  - single `> ` prompt marker
  - multiline input alignment

## Installation

```bash
pi install npm:@smoose/pi-footer
```

## Basic configuration

Configure the plugin under the `footer` key in `~/.pi/agent/settings.json` or project-local `.pi/settings.json`.

Minimal example:

```json
{
  "footer": "default"
}
```

Object form:

```json
{
  "footer": {
    "preset": "default"
  }
}
```

## Presets

Available presets:

```txt
default
minimal
compact
full
nerd
ascii
custom
```

You can switch presets inside pi with:

```txt
/footer default
/footer minimal
/footer compact
/footer full
/footer nerd
/footer ascii
/footer custom
```

Running `/footer` with no arguments toggles the footer on/off for the current session.

## Segment order

Use `footer.segments` to control the exact segment order.

```json
{
  "footer": {
    "preset": "default",
    "segments": [
      "model",
      "thinking",
      "path",
      "git",
      "context_pct",
      "cache_read",
      "cost"
    ]
  }
}
```

The footer renders segments in the array order. If the line is too narrow, later visible segments overflow onto a second footer line.

If `segments` is omitted, the selected preset's default order is used and custom items are appended after preset segments.

## Built-in segments

Supported built-in segment ids:

| Segment | Description |
| --- | --- |
| `model` | Current model name |
| `thinking` | Current thinking level, e.g. `think:med` |
| `shell_mode` | Shell mode status, when available |
| `path` | Current working directory |
| `git` | Git branch and dirty state |
| `subagents` | Reserved segment; currently hidden |
| `token_in` | Input tokens |
| `token_out` | Output tokens |
| `token_total` | Input + output + cache tokens |
| `cost` | Session cost or `(sub)` for subscription usage |
| `context_pct` | Context usage percentage and window size |
| `context_total` | Context window size |
| `time_spent` | Session elapsed time |
| `time` | Current time |
| `session` | Session id prefix |
| `hostname` | Hostname |
| `cache_read` | Cache read tokens |
| `cache_write` | Cache write tokens |
| `extension_statuses` | Remaining extension statuses not lifted into custom items |

## Custom items

Custom items display values from pi extension statuses.

If another extension calls:

```ts
ctx.ui.setStatus("soul-mood", "👻 Susan·厌恶");
```

then you can show it in the footer with:

```json
{
  "footer": {
    "preset": "default",
    "segments": [
      "custom:soul",
      "model",
      "thinking",
      "path",
      "git",
      "context_pct",
      "cache_read",
      "cost"
    ],
    "customItems": [
      {
        "id": "soul",
        "statusKey": "soul-mood",
        "color": "rainbow"
      }
    ]
  }
}
```

Custom segment ids are referenced as:

```txt
custom:<id>
```

For example:

```txt
custom:soul
```

### Custom item fields

| Field | Description |
| --- | --- |
| `id` | Custom item id; used by `custom:<id>` |
| `statusKey` | Key from `ctx.ui.setStatus(key, value)`; defaults to `id` |
| `color` | Optional color name, hex color, or `rainbow` |
| `prefix` | Optional prefix shown before the status value |
| `hideWhenMissing` | Hide the item when no status exists; default `true` |
| `excludeFromExtensionStatuses` | Exclude this status from `extension_statuses`; default `true` |

## Colors

Custom item colors can be:

### Hex colors

```json
{
  "color": "#00afaf"
}
```

### pi theme color names

Examples:

```txt
accent
success
warning
error
muted
dim
text
thinkingHigh
thinkingMedium
borderMuted
```

### Rainbow

```json
{
  "color": "rainbow"
}
```

`rainbow` applies the plugin's built-in per-character rainbow coloring.

## Example configuration

```json
{
  "footer": {
    "preset": "default",
    "segments": [
      "custom:soul",
      "model",
      "thinking",
      "path",
      "git",
      "context_pct",
      "cache_read",
      "cost",
      "extension_statuses"
    ],
    "customItems": [
      {
        "id": "soul",
        "statusKey": "soul-mood",
        "color": "rainbow"
      }
    ]
  }
}
```
