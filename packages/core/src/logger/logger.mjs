/**
 * @file packages/core/src/logger/logger.mjs
 * @description Game-Hub 高性能全链路结构化日志器
 * 提供彩色终端与 Docker 容器友好的时间戳、模块标签与分级输出
 */

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
};

const LevelNames = ["DEBUG", "INFO ", "WARN ", "ERROR", "SILENT"];

// ANSI 色彩配置 (支持 NO_COLOR 环境变量自动关闭)
const noColor = process.env.NO_COLOR !== undefined;
const Colors = {
  reset: noColor ? "" : "\x1b[0m",
  dim: noColor ? "" : "\x1b[2m",
  bold: noColor ? "" : "\x1b[1m",
  gray: noColor ? "" : "\x1b[90m",
  red: noColor ? "" : "\x1b[31m",
  green: noColor ? "" : "\x1b[32m",
  yellow: noColor ? "" : "\x1b[33m",
  blue: noColor ? "" : "\x1b[34m",
  magenta: noColor ? "" : "\x1b[35m",
  cyan: noColor ? "" : "\x1b[36m",
  white: noColor ? "" : "\x1b[37m"
};

export class Logger {
  /**
   * @param {Object} [options]
   * @param {number} [options.level] - 最低日志级别
   * @param {string} [options.prefix] - 全局前缀
   */
  constructor(options = {}) {
    const envLevel = process.env.GAMEHUB_LOG_LEVEL?.toUpperCase();
    this.level = options.level ?? (envLevel && LogLevel[envLevel] !== undefined ? LogLevel[envLevel] : LogLevel.INFO);
    this.prefix = options.prefix || "Game-Hub";
  }

  setLevel(level) {
    if (typeof level === "string") {
      const parsed = LogLevel[level.toUpperCase()];
      if (parsed !== undefined) this.level = parsed;
    } else if (typeof level === "number") {
      this.level = level;
    }
  }

  _formatTime() {
    const d = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, "0");
    const YYYY = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const DD = pad(d.getDate());
    const HH = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    const SSS = pad(d.getMilliseconds(), 3);
    return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}.${SSS}`;
  }

  _log(level, tag, message, extra = null) {
    if (level < this.level) return;

    const timeStr = `${Colors.gray}${this._formatTime()}${Colors.reset}`;
    let levelBadge = "";
    switch (level) {
      case LogLevel.DEBUG:
        levelBadge = `${Colors.gray}[DEBUG]${Colors.reset}`;
        break;
      case LogLevel.INFO:
        levelBadge = `${Colors.green}[INFO ]${Colors.reset}`;
        break;
      case LogLevel.WARN:
        levelBadge = `${Colors.yellow}[WARN ]${Colors.reset}`;
        break;
      case LogLevel.ERROR:
        levelBadge = `${Colors.red}[ERROR]${Colors.reset}`;
        break;
    }

    let tagColor = Colors.cyan;
    if (tag.includes("Gateway")) tagColor = Colors.cyan;
    else if (tag.includes("Dispatcher")) tagColor = Colors.magenta;
    else if (tag.includes("Vault")) tagColor = Colors.yellow;
    else if (tag.includes("Plugin")) tagColor = Colors.blue;
    else if (tag.includes("System")) tagColor = Colors.green;

    const tagBadge = `${tagColor}[${tag}]${Colors.reset}`;
    const formattedMsg = typeof message === "object" ? JSON.stringify(message, null, 2) : String(message);

    const out = `${timeStr} ${levelBadge} ${tagBadge} ${formattedMsg}`;

    if (level >= LogLevel.ERROR) {
      if (extra instanceof Error) {
        console.error(out);
        console.error(`${Colors.red}${extra.stack || extra.message}${Colors.reset}`);
      } else if (extra) {
        console.error(out, extra);
      } else {
        console.error(out);
      }
    } else {
      if (extra) {
        console.log(out, extra);
      } else {
        console.log(out);
      }
    }
  }

  debug(tag, message, extra) {
    this._log(LogLevel.DEBUG, tag, message, extra);
  }

  info(tag, message, extra) {
    this._log(LogLevel.INFO, tag, message, extra);
  }

  warn(tag, message, extra) {
    this._log(LogLevel.WARN, tag, message, extra);
  }

  error(tag, message, extra) {
    this._log(LogLevel.ERROR, tag, message, extra);
  }

  // 专用生命周期便捷输出
  gateway(message, level = LogLevel.INFO) {
    this._log(level, "Gateway", message);
  }

  dispatcher(message, level = LogLevel.INFO) {
    this._log(level, "Dispatcher", message);
  }

  plugin(gameId, message, level = LogLevel.INFO) {
    this._log(level, `Plugin:${gameId}`, message);
  }
}

// 导出单例与类
export const logger = new Logger();
export default logger;
