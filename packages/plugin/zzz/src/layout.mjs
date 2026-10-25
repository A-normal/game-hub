/**
 * @file packages/plugin/zzz/src/layout.mjs
 * @description 纯文本排版层：标题、分区、键值对齐、进度条与分页脚注。
 * 只负责把真实数据排得可读，不生成任何图片，也不填充缺省数据。
 */

// 东亚宽字符按 2 列计算，保证中文与拉丁混排时右边界大致齐平。
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

export function displayWidth(value) {
  let width = 0;
  for (const char of String(value ?? "")) width += WIDE.test(char) ? 2 : 1;
  return width;
}

export function padEndWide(value, width, fill = " ") {
  const text = String(value ?? "");
  return text + fill.repeat(Math.max(0, width - displayWidth(text)));
}

export function title(text) {
  return "【" + String(text) + "】";
}

export function section(text, length = 18) {
  return "─".repeat(2) + " " + String(text) + " " + "─".repeat(Math.max(2, length - displayWidth(text) - 4));
}

export function divider(length = 18) {
  return "─".repeat(length);
}

/**
 * 键值行；默认按最长键名对齐等号后的内容，`separator` 与值之间不再额外补空格。
 * 空值（undefined / null / ""）按“不展示未返回字段”的既有约定跳过。
 */
export function kv(pairs, { indent = "", align = true, separator = ": " } = {}) {
  const rows = (pairs || []).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!rows.length) return [];
  if (!align) return rows.map(([key, value]) => indent + String(key) + separator + String(value));
  const width = Math.max(...rows.map(([key]) => displayWidth(key)));
  return rows.map(([key, value]) => indent + padEndWide(key, width) + separator + String(value));
}

/** 进度条；数值非法时返回空串，调用方据此省略整行。 */
export function bar(current, max, length = 10) {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return "";
  const ratio = Math.max(0, Math.min(1, current / max));
  const filled = Math.round(ratio * length);
  return "[" + "█".repeat(filled) + "░".repeat(length - filled) + "] " + Math.floor(ratio * 100) + "%";
}

export function humanDuration(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? hours + "小时" + minutes + "分" : minutes + "分钟";
}

export function clockAt(seconds, now = Date.now()) {
  const target = new Date(now + Math.max(0, Number(seconds) || 0) * 1000);
  return String(target.getHours()).padStart(2, "0") + ":" + String(target.getMinutes()).padStart(2, "0");
}

/** 列表项；`marker` 可为序号函数，便于分页明细统一缩进。 */
export function list(items, { indent = "  ", marker = "· ", clamp = 0 } = {}) {
  return (items || []).map((item, index) => {
    const lead = typeof marker === "function" ? marker(index) : marker;
    const text = clamp > 0 ? clip(item, clamp) : String(item);
    return indent + lead + text;
  });
}

export function clip(value, max = 200) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text;
}

/** 分页脚注：只有一页时给出总量，多页时给出翻页命令。 */
export function pager(page, nextCommand) {
  if (!page) return "";
  if (page.total <= 1) return "共 " + page.items.length + " 条";
  return "第 " + page.number + " / " + page.total + " 页" + (nextCommand ? "；" + nextCommand : "");
}

export function footer(...parts) {
  return parts.filter(Boolean).join("  ");
}
