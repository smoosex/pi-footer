import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  BuiltinStatusLineSegmentId,
  ColorValue,
  CustomStatusItem,
  PresetDef,
  StatusLinePreset,
  StatusLineSegmentId,
} from "./types.ts";

export interface FooterConfig {
  preset: StatusLinePreset;
  customItems: CustomStatusItem[];
  segments?: StatusLineSegmentId[];
}

const BUILTIN_SEGMENT_IDS: readonly BuiltinStatusLineSegmentId[] = [
  "model",
  "shell_mode",
  "path",
  "git",
  "subagents",
  "token_in",
  "token_out",
  "token_total",
  "cost",
  "context_pct",
  "context_total",
  "time_spent",
  "time",
  "session",
  "hostname",
  "cache_read",
  "cache_write",
  "thinking",
  "extension_statuses",
];

const BUILTIN_SEGMENT_ID_SET = new Set<string>(BUILTIN_SEGMENT_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePreset(value: unknown, presets: readonly StatusLinePreset[]): StatusLinePreset | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (presets as readonly string[]).includes(normalized) ? (normalized as StatusLinePreset) : null;
}

function normalizeCustomItemId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : null;
}

function normalizeCustomColor(value: unknown): ColorValue | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? (normalized as ColorValue) : undefined;
}

function normalizeCustomPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeCustomStatusItem(raw: unknown, idOverride?: string): CustomStatusItem | null {
  if (!isRecord(raw)) return null;
  const id = normalizeCustomItemId(idOverride ?? raw.id);
  if (!id) return null;

  const statusKey = typeof raw.statusKey === "string" && raw.statusKey.trim() ? raw.statusKey.trim() : id;

  return {
    id,
    statusKey,
    color: normalizeCustomColor(raw.color),
    prefix: normalizeCustomPrefix(raw.prefix),
    hideWhenMissing: raw.hideWhenMissing !== false,
    excludeFromExtensionStatuses: raw.excludeFromExtensionStatuses !== false,
  };
}

function normalizeSegmentList(raw: unknown): StatusLineSegmentId[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const normalized: StatusLineSegmentId[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const segmentId = entry.trim();
    if (!segmentId) continue;

    if (BUILTIN_SEGMENT_ID_SET.has(segmentId) || /^custom:[a-zA-Z0-9_-]+$/.test(segmentId)) {
      normalized.push(segmentId as StatusLineSegmentId);
    }
  }

  return normalized;
}

function normalizeCustomItems(raw: unknown): CustomStatusItem[] {
  const normalized: CustomStatusItem[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = normalizeCustomStatusItem(entry);
      if (item) normalized.push(item);
    }
  } else if (isRecord(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const item = normalizeCustomStatusItem(entry, id);
      if (item) normalized.push(item);
    }
  }

  const deduped = new Map<string, CustomStatusItem>();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
}

export function parseFooterConfig(value: unknown, presets: readonly StatusLinePreset[]): FooterConfig {
  const defaultConfig: FooterConfig = { preset: "default", customItems: [] };

  const directPreset = normalizePreset(value, presets);
  if (directPreset) return { ...defaultConfig, preset: directPreset };

  if (!isRecord(value)) return defaultConfig;

  return {
    preset: normalizePreset(value.preset, presets) ?? defaultConfig.preset,
    customItems: normalizeCustomItems(value.customItems),
    segments: normalizeSegmentList(value.segments),
  };
}

export function resolveFooterSegments(
  presetDef: PresetDef,
  customItems: readonly CustomStatusItem[],
  configuredSegments?: readonly StatusLineSegmentId[]
): StatusLineSegmentId[] {
  if (configuredSegments) return [...configuredSegments];

  const segments: StatusLineSegmentId[] = [...presetDef.segments];
  for (const item of customItems) {
    segments.push(`custom:${item.id}`);
  }

  return segments;
}

export function nextFooterSettingWithPreset(existingFooterSetting: unknown, preset: StatusLinePreset): unknown {
  if (!isRecord(existingFooterSetting)) {
    return preset;
  }
  return { ...existingFooterSetting, preset };
}

export function collectHiddenExtensionStatusKeys(customItems: readonly CustomStatusItem[]): Set<string> {
  const hidden = new Set<string>();
  for (const item of customItems) {
    if (item.excludeFromExtensionStatuses) hidden.add(item.statusKey);
  }
  return hidden;
}

export function isNotificationExtensionStatus(value: string): boolean {
  return value.trimStart().startsWith("[");
}

export function getNotificationExtensionStatuses(
  statuses: ReadonlyMap<string, string>,
  hiddenKeys: ReadonlySet<string>,
): string[] {
  const notifications: string[] = [];
  for (const [statusKey, value] of statuses.entries()) {
    if (hiddenKeys.has(statusKey) || !value || !isNotificationExtensionStatus(value)) {
      continue;
    }
    notifications.push(value);
  }
  return notifications;
}

export function normalizeExtensionStatusValue(value: string): string | null {
  if (!value || visibleWidth(value) <= 0) {
    return null;
  }

  const stripped = value.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
  return visibleWidth(stripped) > 0 ? stripped : null;
}

export function normalizeCompactExtensionStatus(value: string): string | null {
  if (isNotificationExtensionStatus(value)) {
    return null;
  }

  return normalizeExtensionStatusValue(value);
}
