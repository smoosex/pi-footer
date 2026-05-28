import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId, ThemeLike } from "./types.ts";
import type { FooterConfig } from "./footer-config.ts";
import {
  collectHiddenExtensionStatusKeys,
  resolveFooterSegments,
  nextFooterSettingWithPreset,
  parseFooterConfig,
} from "./footer-config.ts";
import { getPreset, PRESETS } from "./presets.ts";
import { getSeparator } from "./separators.ts";
import { renderSegment } from "./segments.ts";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch, setGitCacheUpdateCallback } from "./git-status.ts";
import { getColorCode, ANSI_RESET, getDefaultColors } from "./theme.ts";
import { createRenderScheduler } from "./render-scheduler.ts";
import { readCoreContextUsage } from "./context-usage.ts";

// Patch Theme.prototype so the editor border never changes with thinking
// level (already displayed in our footer). Must run at module load time
// before any Theme instances are created. Uses ANSI 244 gray (~#808080),
// matching the separator color in footer segments.
Theme.prototype.getThinkingBorderColor = function () {
  const ansi244 = "\x1b[38;5;244m";
  return (str: string) => `${ansi244}${str}\x1b[0m`;
};

// Monkey-patch target type — FooterDataProvider class is not publicly exported,
// but setExtensionStatus / clearExtensionStatuses exist at runtime on the
// ReadonlyFooterDataProvider instance.
interface InternalFooterDataProvider extends ReadonlyFooterDataProvider {
  setExtensionStatus(key: string, text: string | undefined): void;
  clearExtensionStatuses(): void;
}

interface ExtensionContextRuntimeCompat extends ExtensionContext {
  settingsManager?: {
    getCompactionSettings?: () => { enabled?: boolean } | undefined;
  };
  getThinkingLevel?: () => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const CUSTOM_COMPACTION_STATUS_KEY = "compact-policy";
const LAYOUT_CACHE_TTL_MS = 250;
const STREAMING_LAYOUT_CACHE_TTL_MS = 1000;
const STATUS_RENDER_DEBOUNCE_MS = 33;
const CONTEXT_STATUS_RENDER_MS = 250;
const EDITOR_STATUS_DEFER_MS = 150;
const EDITOR_OUTER_LEFT_MARGIN = 1;
const EDITOR_OUTER_RIGHT_MARGIN = 1;
const EDITOR_PROMPT = "> ";
const EDITOR_PROMPT_WIDTH = visibleWidth(EDITOR_PROMPT);

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SessionAssistantUsage = AssistantMessage["usage"];

function getUsageTokenTotal(usage: SessionAssistantUsage): number {
  const totalTokens = "totalTokens" in usage && typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
  return totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function isSessionAssistantMessage(message: unknown): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant";
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════════════════

function getSettingsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

function getCustomCompactionExtensionPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "extensions", "pi-custom-compaction");
}

function mergeSettings(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(overrideValue)
      ? mergeSettings(baseValue, overrideValue)
      : overrideValue;
  }

  return merged;
}

function readSettingsFile(settingsPath: string): Record<string, unknown> {
  try {
    if (!existsSync(settingsPath)) return {};
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[pi-new-footer] Ignoring non-object settings at ${settingsPath}`);
      return {};
    }
    return parsed;
  } catch (error) {
    console.debug(`[pi-new-footer] Failed to read settings from ${settingsPath}:`, error);
    return {};
  }
}

function readWritableSettingsFile(settingsPath: string): Record<string, unknown> | null {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isRecord(parsed)) {
      console.debug(`[pi-new-footer] Refusing to write settings to non-object file at ${settingsPath}`);
      return null;
    }
    return parsed;
  } catch (error) {
    console.debug(`[pi-new-footer] Failed to parse settings at ${settingsPath}:`, error);
    return null;
  }
}

function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
  return mergeSettings(readSettingsFile(getSettingsPath()), readSettingsFile(getProjectSettingsPath(cwd)));
}

function readCompactionPolicyEnabled(configPath: string): boolean | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return false;
    return parsed.enabled;
  } catch (error) {
    console.debug(`[pi-new-footer] Failed to read compaction policy from ${configPath}:`, error);
    return false;
  }
}

function getGlobalCompactionPolicyPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "compaction-policy.json");
}

function detectCustomCompactionEnabled(cwd: string): boolean {
  if (!existsSync(getCustomCompactionExtensionPath())) return false;
  const projectSetting = readCompactionPolicyEnabled(join(cwd, ".pi", "compaction-policy.json"));
  if (projectSetting !== undefined) return projectSetting;
  return readCompactionPolicyEnabled(getGlobalCompactionPolicyPath()) ?? false;
}

function writeFooterSetting(cwd: string, update: (existingFooterSetting: unknown) => unknown): boolean {
  const globalSettingsPath = getSettingsPath();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalSettings = readWritableSettingsFile(globalSettingsPath);
  const projectSettings = readWritableSettingsFile(projectSettingsPath);

  if (globalSettings === null || projectSettings === null) return false;

  const writeToProject = Object.prototype.hasOwnProperty.call(projectSettings, "footer");
  const settingsPath = writeToProject ? projectSettingsPath : globalSettingsPath;
  const settings = writeToProject ? projectSettings : globalSettings;

  settings.footer = update(settings.footer);

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return true;
  } catch (error) {
    console.debug(`[pi-footer] Failed to persist footer setting to ${settingsPath}:`, error);
    return false;
  }
}

function writeFooterPresetSetting(preset: StatusLinePreset, cwd: string = process.cwd()): boolean {
  return writeFooterSetting(cwd, (existingFooterSetting) =>
    nextFooterSettingWithPreset(existingFooterSetting, preset)
  );
}

const PRESET_NAMES = Object.keys(PRESETS) as StatusLinePreset[];

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>,
  theme: ThemeLike,
  colors: ColorScheme
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getColorCode(theme, "separator", colors);
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ANSI_RESET} `) + ANSI_RESET + " ";
}

function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number,
  customItems: FooterConfig["customItems"]
): { topContent: string; overflowContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2;

  const allSegmentIds = resolveFooterSegments(presetDef, customItems, ctx.footerSegments);

  const renderedSegments: { content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ content, width });
    }
  }

  if (renderedSegments.length === 0) {
    return { topContent: "", overflowContent: "" };
  }

  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let overflowSegments: { content: string; width: number }[] = [];
  let overflow = false;

  for (const seg of renderedSegments) {
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);
    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      overflow = true;
      overflowSegments.push(seg);
    }
  }

  let overflowWidth = baseOverhead;
  let overflowLineSegments: string[] = [];
  for (const seg of overflowSegments) {
    const neededWidth = seg.width + (overflowLineSegments.length > 0 ? sepWidth : 0);
    if (overflowWidth + neededWidth <= availableWidth) {
      overflowLineSegments.push(seg.content);
      overflowWidth += neededWidth;
    } else {
      break;
    }
  }

  return {
    topContent: buildContentFromParts(topSegments, presetDef, ctx.theme, ctx.colors),
    overflowContent: buildContentFromParts(overflowLineSegments, presetDef, ctx.theme, ctx.colors),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Editor Chrome
// ═══════════════════════════════════════════════════════════════════════════

class PromptedEditor extends CustomEditor {
  setPaddingX(_padding: number): void {
    // Reserve just enough leading space for the one prompt marker. We strip this
    // reserved space back out while rendering, so the editor itself has no extra
    // internal padding beyond the prompt.
    super.setPaddingX(EDITOR_PROMPT_WIDTH);
  }

  render(width: number): string[] {
    const outerLeft = " ".repeat(EDITOR_OUTER_LEFT_MARGIN);
    const outerRight = " ".repeat(EDITOR_OUTER_RIGHT_MARGIN);
    const editorWidth = Math.max(1, width - EDITOR_OUTER_LEFT_MARGIN - EDITOR_OUTER_RIGHT_MARGIN);
    const lines = super.render(editorWidth);
    const reservedPromptSpace = " ".repeat(EDITOR_PROMPT_WIDTH);
    let promptRendered = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Editor text rows start with padding spaces. Stop at the bottom border so
      // autocomplete rows keep their normal alignment under the input box.
      if (!line.startsWith(" ")) break;
      if (line.startsWith(reservedPromptSpace)) {
        if (!promptRendered) {
          lines[i] = EDITOR_PROMPT + line.slice(reservedPromptSpace.length);
          promptRendered = true;
        }
      }
    }

    return lines.map((line) => {
      const padding = " ".repeat(Math.max(0, editorWidth - visibleWidth(line)));
      return `${outerLeft}${line}${padding}${outerRight}`;
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function footerExtension(pi: ExtensionAPI) {
  const startupSettings = readSettings();
  let config: FooterConfig = parseFooterConfig(startupSettings.footer, PRESET_NAMES);
  let customCompactionEnabled = false;

  let enabled = true;
  let sessionStartTime = Date.now();
  let currentCtx: ExtensionContext | null = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let currentThinkingLevel: string | null = null;
  let liveAssistantUsage: SessionAssistantUsage | null = null;
  let isStreaming = false;
  let tuiRef: TUI | null = null;
  let restoreFooterStatusRepaintHook: (() => void) | null = null;
  let lastEditorInputAt = 0;

  // Layout cache
  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; overflowContent: string } | null = null;
  let lastLayoutTimestamp = 0;
  let layoutDirty = true;
  let forceNextLayoutRecompute = false;

  // Footer already registered flag
  let footerRegistered = false;

  const statusRenderScheduler = createRenderScheduler(() => {
    const msSinceInput = Date.now() - lastEditorInputAt;
    if (layoutDirty && !forceNextLayoutRecompute && msSinceInput < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule(Math.max(0, EDITOR_STATUS_DEFER_MS - msSinceInput));
      return;
    }
    tuiRef?.requestRender();
  }, STATUS_RENDER_DEBOUNCE_MS);

  const resetLayoutCache = () => {
    lastLayoutResult = null;
    layoutDirty = true;
  };

  const requestStatusRender = (delayMs?: number) => {
    layoutDirty = true;
    statusRenderScheduler.schedule(delayMs);
  };

  const requestImmediateStatusRender = (options: { deferDuringTyping?: boolean } = {}) => {
    layoutDirty = true;
    if (options.deferDuringTyping !== false && Date.now() - lastEditorInputAt < EDITOR_STATUS_DEFER_MS) {
      statusRenderScheduler.schedule();
      return;
    }
    forceNextLayoutRecompute = true;
    statusRenderScheduler.cancel();
    statusRenderScheduler.schedule(0);
  };

  const installFooterStatusRepaintHook = (footerData: ReadonlyFooterDataProvider) => {
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;

    const writableFooterData = footerData as InternalFooterDataProvider;
    if (!writableFooterData || typeof writableFooterData.setExtensionStatus !== "function") {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(writableFooterData, "setExtensionStatus");
    if (Object.isFrozen(writableFooterData) || (descriptor && descriptor.configurable === false)) {
      return;
    }

    try {
      const originalSetExtensionStatus = writableFooterData.setExtensionStatus;
      const originalClearExtensionStatuses = writableFooterData.clearExtensionStatuses;

      const setExtensionStatusAndRepaint = function setExtensionStatusAndRepaint(
        this: unknown,
        key: string,
        text: string | undefined
      ) {
        originalSetExtensionStatus.call(this, key, text);
        requestImmediateStatusRender();
      };
      writableFooterData.setExtensionStatus = setExtensionStatusAndRepaint;

      let clearExtensionStatusesAndRepaint: (() => void) | null = null;
      if (typeof originalClearExtensionStatuses === "function") {
        clearExtensionStatusesAndRepaint = function clearExtensionStatusesAndRepaint(this: unknown) {
          originalClearExtensionStatuses.call(this);
          requestImmediateStatusRender();
        };
        writableFooterData.clearExtensionStatuses = clearExtensionStatusesAndRepaint;
      }

      restoreFooterStatusRepaintHook = () => {
        try {
          if (writableFooterData.setExtensionStatus === setExtensionStatusAndRepaint) {
            writableFooterData.setExtensionStatus = originalSetExtensionStatus;
          }
          if (
            clearExtensionStatusesAndRepaint &&
            writableFooterData.clearExtensionStatuses === clearExtensionStatusesAndRepaint
          ) {
            writableFooterData.clearExtensionStatuses = originalClearExtensionStatuses;
          }
        } catch {
          // Ignore restore failures gracefully
        }
      };
    } catch {
      // Ignore monkey patch setup failures gracefully
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Segment Context Builder
  // ═══════════════════════════════════════════════════════════════════════

  function buildSegmentContext(ctx: ExtensionContext, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession: string | null = null;

    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      if (!isRecord(e)) continue;

      if (e.type === "thinking_level_change" && typeof e.thinkingLevel === "string") {
        thinkingLevelFromSession = e.thinkingLevel;
      }

      if (e.type !== "message" || !isSessionAssistantMessage(e.message)) continue;

      const m = e.message;
      if (m.stopReason === "error" || m.stopReason === "aborted") continue;
      input += m.usage.input;
      output += m.usage.output;
      cacheRead += m.usage.cacheRead;
      cacheWrite += m.usage.cacheWrite;
      cost += m.usage.cost.total;
      if (getUsageTokenTotal(m.usage) > 0) {
        lastAssistant = m;
      }
    }

    const latestUsage = isStreaming ? liveAssistantUsage ?? lastAssistant?.usage : lastAssistant?.usage;
    const coreContextUsage = isStreaming && liveAssistantUsage ? null : readCoreContextUsage(ctx);
    const contextTokens = coreContextUsage?.contextTokens ?? (latestUsage ? getUsageTokenTotal(latestUsage) : 0);
    const contextWindow = coreContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent = coreContextUsage?.contextPercent ?? (contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0);

    const gitBranch = footerDataRef?.getGitBranch() ?? null;
    const gitStatus = getGitStatus(gitBranch);
    const extensionStatuses = footerDataRef?.getExtensionStatuses() ?? new Map();
    const customItemsById = new Map(config.customItems.map((item) => [item.id, item]));
    const hiddenExtensionStatusKeys = collectHiddenExtensionStatusKeys(config.customItems);

    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    const thinkingLevel = currentThinkingLevel ?? thinkingLevelFromSession ?? getThinkingLevelFn?.() ?? "off";

    return {
      model: ctx.model,
      thinkingLevel,
      sessionId: ctx.sessionManager?.getSessionId?.(),
      cwd: ctx.cwd,
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      contextPercent,
      contextWindow,
      autoCompactEnabled: (ctx as ExtensionContextRuntimeCompat).settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      customCompactionEnabled: customCompactionEnabled || extensionStatuses.has(CUSTOM_COMPACTION_STATUS_KEY),
      usingSubscription,
      sessionStartTime,
      shellModeActive: false,
      shellRunning: false,
      shellName: null,
      shellCwd: null,
      git: gitStatus,
      extensionStatuses,
      hiddenExtensionStatusKeys,
      customItemsById,
      footerSegments: config.segments,
      options: presetDef.segmentOptions ?? {},
      theme,
      colors,
    };
  }

  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; overflowContent: string } {
    if (!currentCtx) return { topContent: "", overflowContent: "" };

    const now = Date.now();
    const cacheTtl = isStreaming ? STREAMING_LAYOUT_CACHE_TTL_MS : LAYOUT_CACHE_TTL_MS;

    if (lastLayoutResult && lastLayoutWidth === width) {
      const msSinceInput = now - lastEditorInputAt;
      const typingRecently = msSinceInput < EDITOR_STATUS_DEFER_MS;

      if (!forceNextLayoutRecompute && typingRecently && (layoutDirty || now - lastLayoutTimestamp >= cacheTtl)) {
        return lastLayoutResult;
      }

      if (!layoutDirty && now - lastLayoutTimestamp < cacheTtl) {
        return lastLayoutResult;
      }
    }

    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, theme);

    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, width, config.customItems);
    lastLayoutTimestamp = now;
    layoutDirty = false;
    forceNextLayoutRecompute = false;

    return lastLayoutResult;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Register Footer
  // ═══════════════════════════════════════════════════════════════════════

  function registerFooter(ctx: ExtensionContext) {
    if (footerRegistered) return; // Only register once per session

    ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
      footerDataRef = footerData;
      tuiRef = tui;
      installFooterStatusRepaintHook(footerData);
      const unsub = footerData.onBranchChange(() => requestStatusRender());

      footerRegistered = true;

      return {
        dispose() {
          footerRegistered = false;
          unsub();
          restoreFooterStatusRepaintHook?.();
          restoreFooterStatusRepaintHook = null;
          footerDataRef = null;
          tuiRef = null;
        },
        invalidate() {
          requestStatusRender();
        },
        render(width: number): string[] {
          if (!enabled || !currentCtx) return [];

          const layout = getResponsiveLayout(width, theme);
          const lines: string[] = [];

          if (layout.topContent) {
            lines.push(layout.topContent);
          }

          if (layout.overflowContent) {
            lines.push(layout.overflowContent);
          }

          return lines;
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Hooks
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    customCompactionEnabled = detectCustomCompactionEnabled(ctx.cwd);
    isStreaming = false;
    liveAssistantUsage = null;

    const settings = readSettings(ctx.cwd);
    config = parseFooterConfig(settings.footer, PRESET_NAMES);

    const runtimeCtx = ctx as ExtensionContextRuntimeCompat;
    getThinkingLevelFn = typeof runtimeCtx.getThinkingLevel === "function"
      ? () => runtimeCtx.getThinkingLevel?.() ?? "off"
      : null;
    currentThinkingLevel = getThinkingLevelFn?.() ?? null;

    if (ctx.hasUI) {
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
        new PromptedEditor(tui, editorTheme, keybindings)
      );
    }

    if (enabled && ctx.hasUI) {
      registerFooter(ctx);
    }

    setGitCacheUpdateCallback(() => requestStatusRender());
  });

  pi.on("session_shutdown", async () => {
    setGitCacheUpdateCallback(null);
    statusRenderScheduler.cancel();
    restoreFooterStatusRepaintHook?.();
    restoreFooterStatusRepaintHook = null;
    footerRegistered = false;
    currentCtx = null;
    footerDataRef = null;
    getThinkingLevelFn = null;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    tuiRef = null;
    resetLayoutCache();
  });

  // Invalidate git status on file writes and potential branch changes
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  pi.on("tool_result", async (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }
    if (event.toolName === "bash" && event.input?.command) {
      const cmd = String(event.input.command);
      if (mightChangeGitBranch(cmd)) {
        invalidateGitStatus();
        invalidateGitBranch();
        setTimeout(() => requestStatusRender(), 100);
      }
    }
  });

  pi.on("user_bash", async (event) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitStatus();
      invalidateGitBranch();
      setTimeout(() => requestStatusRender(), 100);
      setTimeout(() => requestStatusRender(), 300);
      setTimeout(() => requestStatusRender(), 500);
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    currentCtx = ctx;
    requestStatusRender();
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = getThinkingLevelFn?.() ?? (typeof event.level === "string" ? event.level : null);
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
    currentThinkingLevel = null;
    liveAssistantUsage = null;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("agent_start", async (_event, ctx) => {
    isStreaming = true;
    liveAssistantUsage = null;
    currentCtx = ctx;
  });

  pi.on("message_update", async (event, ctx) => {
    if (isSessionAssistantMessage(event.message)
      && event.message.stopReason !== "error"
      && event.message.stopReason !== "aborted"
      && getUsageTokenTotal(event.message.usage) > 0) {
      liveAssistantUsage = event.message.usage;
      currentCtx = ctx;
      layoutDirty = true;
      statusRenderScheduler.schedule(CONTEXT_STATUS_RENDER_MS);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    currentCtx = ctx;
    if (isSessionAssistantMessage(event.message)) {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        liveAssistantUsage = null;
      } else if (getUsageTokenTotal(event.message.usage) > 0) {
        liveAssistantUsage = event.message.usage;
      }
    }
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    requestImmediateStatusRender({ deferDuringTyping: false });
  });

  pi.on("agent_end", async (_event, ctx) => {
    isStreaming = false;
    liveAssistantUsage = null;
    currentCtx = ctx;
    requestStatusRender();
  });

  // Track editor input timing for deferred layout
  (pi.on as unknown as (event: "editor_change", handler: () => Promise<void>) => void)("editor_change", async () => {
    lastEditorInputAt = Date.now();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Commands
  // ═══════════════════════════════════════════════════════════════════════

  pi.registerCommand("footer", {
    description: "Configure footer status (toggle, preset)",
    handler: async (args, ctx) => {
      currentCtx = ctx;

      if (!args?.trim()) {
        // Toggle on/off
        enabled = !enabled;
        if (enabled) {
          if (ctx.hasUI) {
            registerFooter(ctx);
          }
          ctx.ui.notify("Footer status bar enabled", "info");
        } else {
          // Clear footer
          ctx.ui.setFooter(undefined);
          footerRegistered = false;
          footerDataRef = null;
          tuiRef = null;
          currentCtx = null;
          statusRenderScheduler.cancel();
          resetLayoutCache();
          ctx.ui.notify("Footer status bar disabled", "info");
        }
        return;
      }

      const preset = args.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(PRESETS, preset)) {
        config.preset = preset as StatusLinePreset;
        resetLayoutCache();
        if (enabled && ctx.hasUI) {
          registerFooter(ctx);
        }
        requestImmediateStatusRender({ deferDuringTyping: false });

        if (writeFooterPresetSetting(preset as StatusLinePreset, ctx.cwd)) {
          ctx.ui.notify(`Preset set to: ${preset}`, "info");
        } else {
          ctx.ui.notify(`Preset set to: ${preset} (not persisted; check settings.json)`, "warning");
        }
        return;
      }

      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });
}
