/**
 * @file packages/plugin/zzz/src/utils/qr-encoder.mjs
 * @description 二维码生成引擎：优先采用行业标准 qrcode 库生成 100% 规范无损 PNG Base64，
 * 并保留内置零依赖应急回退机制与终端 ASCII 字符矩阵生成。
 */

import zlib from "node:zlib";

/**
 * 使用标准 qrcode 库异步生成 PNG Base64 (base64://...)
 * @param {string} text
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
export async function generateQrPngBase64(text, options = {}) {
  try {
    const QRCodeModule = await import("qrcode");
    const QRCode = QRCodeModule.default || QRCodeModule;
    const dataUrl = await QRCode.toDataURL(text, {
      errorCorrectionLevel: options.errorCorrectionLevel || "M",
      margin: options.margin !== undefined ? options.margin : 2,
      scale: options.scale || 6
    });
    return dataUrl.replace("data:image/png;base64,", "base64://");
  } catch (err) {
    // 回退到内置纯 JS 生成器
    const fallback = encodeQRCode(text);
    return fallback.toPngBase64(options.scale || 6);
  }
}

// QR Code 伽罗瓦域 GF(256) 算术表与纯 JS 编码器
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let val = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = val;
    EXP[i + 255] = val;
    LOG[val] = i;
    val = (val << 1) ^ (val >= 128 ? 0x11d : 0);
  }
  LOG[0] = 0;
})();

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return EXP[LOG[x] + LOG[y]];
}

function polyMul(p1, p2) {
  const res = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      res[i + j] ^= gfMul(p1[i], p2[j]);
    }
  }
  return res;
}

function getGenPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    poly = polyMul(poly, new Uint8Array([1, EXP[i]]));
  }
  return poly;
}

function calcEcc(data, eccLen) {
  const gen = getGenPoly(eccLen);
  const msg = new Uint8Array(data.length + eccLen);
  msg.set(data);

  for (let i = 0; i < data.length; i++) {
    const lead = msg[i];
    if (lead !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], lead);
      }
    }
  }
  return msg.slice(data.length);
}

const VERSION_PARAMS_L = [
  null,
  [19, 7, 1],
  [34, 10, 1],
  [55, 15, 1],
  [80, 20, 1],
  [108, 26, 1],
  [136, 18, 2],
  [156, 20, 2],
  [194, 24, 2],
  [232, 30, 2],
  [274, 18, 4]
];

const ALIGNMENT_PATTERNS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
];

export function encodeQRCode(text) {
  const textBytes = Buffer.from(text, "utf-8");
  const len = textBytes.length;

  let version = 1;
  while (version <= 10) {
    const maxData = VERSION_PARAMS_L[version][0];
    if (len + 2 <= maxData) break;
    version++;
  }
  if (version > 10) {
    throw new Error(`文本长度 (${len} 字节) 超过内建二维码生成器上限 (270 字节)`);
  }

  const [totalDataBytes, eccPerBlock, numBlocks] = VERSION_PARAMS_L[version];
  const size = 17 + version * 4;

  let bits = "";
  bits += "0100";
  bits += len.toString(2).padStart(version <= 9 ? 8 : 16, "0");
  for (let i = 0; i < len; i++) {
    bits += textBytes[i].toString(2).padStart(8, "0");
  }

  const totalDataBits = totalDataBytes * 8;
  if (bits.length < totalDataBits) bits += "0000".slice(0, totalDataBits - bits.length);
  while (bits.length % 8 !== 0) bits += "0";

  const padBytes = ["11101100", "00010001"];
  let padIdx = 0;
  while (bits.length < totalDataBits) {
    bits += padBytes[padIdx % 2];
    padIdx++;
  }

  const dataBytes = new Uint8Array(totalDataBytes);
  for (let i = 0; i < totalDataBytes; i++) {
    dataBytes[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
  }

  const blockSize = Math.floor(totalDataBytes / numBlocks);
  const eccBlocks = [];
  const dataBlocks = [];
  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    const end = (b === numBlocks - 1) ? totalDataBytes : (b + 1) * blockSize;
    const blockData = dataBytes.slice(start, end);
    dataBlocks.push(blockData);
    eccBlocks.push(calcEcc(blockData, eccPerBlock));
  }

  const finalCodewords = [];
  const maxBlockLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxBlockLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) finalCodewords.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      finalCodewords.push(eccBlocks[b][i]);
    }
  }

  const matrix = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  function setModule(x, y, isDark) {
    matrix[y][x] = isDark ? 2 : 1;
    isFunction[y][x] = 1;
  }

  function drawFinder(ox, oy) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx;
        const y = oy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const isDark = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) &&
            (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
          setModule(x, y, isDark);
        }
      }
    }
  }
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  for (let i = 8; i < size - 8; i++) {
    if (!isFunction[6][i]) setModule(i, 6, i % 2 === 0);
    if (!isFunction[i][6]) setModule(6, i, i % 2 === 0);
  }

  const alignPos = ALIGNMENT_PATTERNS[version];
  for (let r = 0; r < alignPos.length; r++) {
    for (let c = 0; c < alignPos.length; c++) {
      const cx = alignPos[c];
      const cy = alignPos[r];
      if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const isDark = Math.abs(dx) === 2 || Math.abs(dy) === 2 || (dx === 0 && dy === 0);
          setModule(cx + dx, cy + dy, isDark);
        }
      }
    }
  }

  setModule(8, 4 * version + 9, true);

  for (let i = 0; i <= 8; i++) {
    if (!isFunction[8][i]) isFunction[8][i] = 1;
    if (!isFunction[i][8]) isFunction[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunction[8][size - 1 - i]) isFunction[8][size - 1 - i] = 1;
    if (!isFunction[size - 1 - i][8]) isFunction[size - 1 - i][8] = 1;
  }

  const bitArray = [];
  for (const byte of finalCodewords) {
    for (let b = 7; b >= 0; b--) {
      bitArray.push((byte >> b) & 1);
    }
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    const colList = [right, right - 1];
    const rowRange = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const y of rowRange) {
      for (const x of colList) {
        if (!isFunction[y][x]) {
          const bit = bitIdx < bitArray.length ? bitArray[bitIdx++] : 0;
          const mask = (x + y) % 2 === 0;
          matrix[y][x] = (bit ^ (mask ? 1 : 0)) ? 2 : 1;
        }
      }
    }
    upward = !upward;
  }

  const FORMAT_BITS = 0b111011111000100;
  for (let i = 0; i < 6; i++) matrix[8][i] = ((FORMAT_BITS >> (14 - i)) & 1) ? 2 : 1;
  matrix[8][7] = ((FORMAT_BITS >> 8) & 1) ? 2 : 1;
  matrix[8][8] = ((FORMAT_BITS >> 7) & 1) ? 2 : 1;
  matrix[7][8] = ((FORMAT_BITS >> 6) & 1) ? 2 : 1;
  for (let i = 0; i < 6; i++) matrix[5 - i][8] = ((FORMAT_BITS >> (5 - i)) & 1) ? 2 : 1;

  for (let i = 0; i < 7; i++) matrix[size - 1 - i][8] = ((FORMAT_BITS >> (14 - i)) & 1) ? 2 : 1;
  for (let i = 0; i < 8; i++) matrix[8][size - 8 + i] = ((FORMAT_BITS >> (7 - i)) & 1) ? 2 : 1;

  const grid = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => matrix[y][x] === 2)
  );

  return {
    size,
    version,
    grid,
    toAscii() {
      let out = "";
      for (let y = 0; y < size; y += 2) {
        for (let x = 0; x < size; x++) {
          const top = grid[y][x];
          const bot = y + 1 < size ? grid[y + 1][x] : false;
          if (top && bot) out += "█";
          else if (top && !bot) out += "▀";
          else if (!top && bot) out += "▄";
          else out += " ";
        }
        out += "\n";
      }
      return out;
    },
    toBmpBase64(scale = 4) {
      const border = 2;
      const bSize = size + border * 2;
      const imgWidth = bSize * scale;
      const imgHeight = bSize * scale;
      const rowBytes = Math.ceil(imgWidth / 8);
      const rowPadding = (4 - (rowBytes % 4)) % 4;
      const imageSize = (rowBytes + rowPadding) * imgHeight;
      const fileSize = 54 + 8 + imageSize;

      const buf = Buffer.alloc(fileSize);
      buf.write("BM", 0, "ascii");
      buf.writeUInt32LE(fileSize, 2);
      buf.writeUInt32LE(54 + 8, 10);
      buf.writeUInt32LE(40, 14);
      buf.writeInt32LE(imgWidth, 18);
      buf.writeInt32LE(imgHeight, 22);
      buf.writeUInt16LE(1, 26);
      buf.writeUInt16LE(1, 28);
      buf.writeUInt32LE(0, 30);
      buf.writeUInt32LE(imageSize, 34);
      buf.writeInt32LE(2835, 38);
      buf.writeInt32LE(2835, 42);
      buf.writeUInt32LE(2, 46);
      buf.writeUInt32LE(0, 50);

      buf.writeUInt32LE(0x00000000, 54);
      buf.writeUInt32LE(0x00ffffff, 58);

      let offset = 62;
      for (let y = imgHeight - 1; y >= 0; y--) {
        const gy = Math.floor(y / scale) - border;
        for (let b = 0; b < rowBytes; b++) {
          let byteVal = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x = b * 8 + bit;
            if (x < imgWidth) {
              const gx = Math.floor(x / scale) - border;
              const isBlack = (gx >= 0 && gx < size && gy >= 0 && gy < size) ? grid[gy][gx] : false;
              if (!isBlack) byteVal |= (1 << (7 - bit));
            } else {
              byteVal |= (1 << (7 - bit));
            }
          }
          buf.writeUInt8(byteVal, offset++);
        }
        offset += rowPadding;
      }
      return "base64://" + buf.toString("base64");
    },
    toPngBase64(scale = 6) {
      const border = 2;
      const bSize = size + border * 2;
      const imgWidth = bSize * scale;
      const imgHeight = bSize * scale;
      const rowBytes = 1 + imgWidth;
      const rawData = Buffer.alloc(imgHeight * rowBytes);

      let offset = 0;
      for (let y = 0; y < imgHeight; y++) {
        rawData[offset++] = 0;
        const gy = Math.floor(y / scale) - border;
        for (let x = 0; x < imgWidth; x++) {
          const gx = Math.floor(x / scale) - border;
          const isBlack = (gx >= 0 && gx < size && gy >= 0 && gy < size) ? grid[gy][gx] : false;
          rawData[offset++] = isBlack ? 0 : 255;
        }
      }

      const idatData = zlib.deflateSync(rawData, { level: 9 });

      function crc32(buf) {
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) {
          crc ^= buf[i];
          for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
          }
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      function makeChunk(type, data) {
        const len = data.length;
        const chunk = Buffer.alloc(4 + 4 + len + 4);
        chunk.writeUInt32BE(len, 0);
        chunk.write(type, 4, 4, "ascii");
        data.copy(chunk, 8);
        const crcBuf = Buffer.concat([Buffer.from(type, "ascii"), data]);
        chunk.writeUInt32BE(crc32(crcBuf), 8 + len);
        return chunk;
      }

      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(imgWidth, 0);
      ihdr.writeUInt32BE(imgHeight, 4);
      ihdr.writeUInt8(8, 8);
      ihdr.writeUInt8(0, 9);
      ihdr.writeUInt8(0, 10);
      ihdr.writeUInt8(0, 11);
      ihdr.writeUInt8(0, 12);

      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdrChunk = makeChunk("IHDR", ihdr);
      const idatChunk = makeChunk("IDAT", idatData);
      const iendChunk = makeChunk("IEND", Buffer.alloc(0));

      const png = Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
      return "base64://" + png.toString("base64");
    }
  };
}

export default encodeQRCode;
