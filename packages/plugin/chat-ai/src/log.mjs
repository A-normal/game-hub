/** 正常记录警告与错误；debug 只控制详细诊断，不包含正文和密钥。 */
export function createLogger(config = {}) {
  const enabled = config.debug === true;
  const write = (level, message) => {
    if (!enabled && ["DEBUG", "INFO"].includes(level)) return;
    const safe = String(message ?? "").replace(/\bsk-[A-Za-z0-9_-]+/g,"***").replace(/Bearer\s+\S+/gi,"Bearer ***");
    console.warn("[chat-ai][" + level + "] " + safe);
  };
  return {enabled, debug:m=>write("DEBUG",m),info:m=>write("INFO",m),warn:m=>write("WARN",m),error:m=>write("ERROR",m)};
}
export default createLogger;
