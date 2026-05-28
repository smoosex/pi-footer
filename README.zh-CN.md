# pi-footer

中文 | [English](./README.md)

一个用于 [pi](https://github.com/earendil-works/pi) coding agent 的精简 footer / 状态栏扩展。

这个插件是对 [`nicobailon/pi-powerline-footer`](https://github.com/nicobailon/pi-powerline-footer) 的精简版本，并在此基础上添加了一些新功能，例如自定义 segment 顺序、自定义 extension status 展示、`rainbow` 彩虹色，以及带提示符的输入框样式。

## 功能特性

- Powerline 风格 footer 状态栏
- 多种预设布局
- 通过 `footer.segments` 完全自定义展示顺序
- 支持展示其他扩展上报的状态
- custom item 支持 `rainbow` 彩虹色
- 响应式 overflow：第一行放不下的内容会自动进入下一行
- 输入框样式增强：
  - 左右外边距
  - 单个 `> ` 提示符
  - 多行输入对齐

## 安装

```bash
pi install npm:@smoose/pi-footer
```

## 基础配置

插件配置写在 `~/.pi/agent/settings.json` 或项目内 `.pi/settings.json` 的 `footer` 字段下。

最简单的写法：

```json
{
  "footer": "default"
}
```

对象写法：

```json
{
  "footer": {
    "preset": "default"
  }
}
```

## 预设

可用 preset：

```txt
default
minimal
compact
full
nerd
ascii
custom
```

可以在 pi 里通过命令切换：

```txt
/footer default
/footer minimal
/footer compact
/footer full
/footer nerd
/footer ascii
/footer custom
```

不带参数执行：

```txt
/footer
```

会在当前 session 中启用 / 禁用 footer。

## 自定义展示顺序

使用 `footer.segments` 控制 footer 的完整展示顺序。

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

footer 会严格按照数组顺序从左到右渲染。终端宽度不够时，后面的可见 segment 会自动进入第二行。

如果不配置 `segments`，则使用 preset 默认顺序，并把 custom item 追加到 preset segment 后面。

## 内置 segment

支持的内置 segment id：

| Segment | 说明 |
| --- | --- |
| `model` | 当前模型名 |
| `thinking` | 当前 thinking level，例如 `think:med` |
| `shell_mode` | Shell 模式状态；有值时展示 |
| `path` | 当前工作目录 |
| `git` | Git 分支和工作区状态 |
| `subagents` | 预留项，目前默认隐藏 |
| `token_in` | 输入 token 数 |
| `token_out` | 输出 token 数 |
| `token_total` | 输入 + 输出 + cache token 总数 |
| `cost` | 当前 session 花费，或订阅模式下显示 `(sub)` |
| `context_pct` | 上下文占用百分比和上下文窗口大小 |
| `context_total` | 上下文窗口大小 |
| `time_spent` | 当前 session 已用时 |
| `time` | 当前时间 |
| `session` | Session id 前缀 |
| `hostname` | 主机名 |
| `cache_read` | Cache read token 数 |
| `cache_write` | Cache write token 数 |
| `extension_statuses` | 其他未被 custom item 单独展示的 extension status 汇总 |

## 自定义内容 customItems

custom item 用于展示其他扩展通过 `ctx.ui.setStatus(...)` 上报的状态。

例如某个扩展调用：

```ts
ctx.ui.setStatus("soul-mood", "👻 Susan·厌恶");
```

那么可以这样在 footer 中展示：

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

custom item 在 `segments` 中通过下面这种形式引用：

```txt
custom:<id>
```

比如：

```txt
custom:soul
```

### custom item 字段

| 字段 | 说明 |
| --- | --- |
| `id` | custom item id，用于 `custom:<id>` 引用 |
| `statusKey` | 对应 `ctx.ui.setStatus(key, value)` 的 key；默认等于 `id` |
| `color` | 可选颜色：theme 色名、hex 色值或 `rainbow` |
| `prefix` | 可选前缀，会显示在状态值前面 |
| `hideWhenMissing` | 找不到对应 status 时是否隐藏，默认 `true` |
| `excludeFromExtensionStatuses` | 是否从 `extension_statuses` 汇总中排除，默认 `true` |

## 颜色

custom item 的 `color` 支持三种形式。

### Hex 色值

```json
{
  "color": "#00afaf"
}
```

### pi theme 色名

例如：

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

### 彩虹色

```json
{
  "color": "rainbow"
}
```

`rainbow` 会使用插件内置的逐字符彩虹色渲染。

## 完整示例

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
