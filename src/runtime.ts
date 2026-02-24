/**
 * 微信客服插件运行时管理 (singleton)
 */

import type { PluginRuntime } from "./types.js";

let runtime: PluginRuntime | null = null;

export function setWecomKfRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWecomKfRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error(
      "WeCom KF runtime not initialized. Make sure the plugin is properly registered."
    );
  }
  return runtime;
}

export function tryGetWecomKfRuntime(): PluginRuntime | null {
  return runtime;
}
