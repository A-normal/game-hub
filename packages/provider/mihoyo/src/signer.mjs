import { createHash, randomBytes, randomInt } from "node:crypto";

// Wire protocol parameters; callers may override these when the service changes.
export const SALTS = Object.freeze({
  record: "xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs",
  overseas: "okr4obncj8bw5a65hbnn5oo6ixjc3l9w",
  community: "WGtruoQrwczmsjLOPXzJLnaAYycsLavx"
});
export function signDs({ salt, generation = 2, query = "", body = "", timestamp = Math.floor(Date.now() / 1000), nonce }) {
  if (!salt || ![1, 2].includes(generation) || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError("Invalid DS options");
  nonce ??= generation === 2 ? String(randomInt(100000, 200001)) : randomBytes(3).toString("hex");
  if (!(generation === 2 ? /^\d+$/ : /^[a-z0-9]{6}$/).test(nonce)) throw new TypeError("Invalid DS nonce");
  const canonical = String(query).replace(/^\?/, "").split("&").filter(Boolean).sort().join("&");
  const payload = "salt=" + salt + "&t=" + timestamp + "&r=" + nonce + (generation === 2 ? "&b=" + body + "&q=" + canonical : "");
  return timestamp + "," + nonce + "," + createHash("md5").update(payload).digest("hex");
}
// Kept as named exports for existing consumers; use signDs for explicit protocol selection.
export const getDs1 = (query = "", body = "") => signDs({ salt: SALTS.record, query, body });
export const getDs2 = () => signDs({ salt: SALTS.community, generation: 1 });
