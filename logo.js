const { createCanvas, loadImage } = require("canvas");
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// ─── Caches ───────────────────────────────────────────────────────────────────

/**
 * Cache ảnh nền — đọc từ disk một lần cho toàn bộ phiên chạy.
 * bg-soccer.jpg không thay đổi giữa các lần gọi createMatchImage().
 */
let _bgImageCache = null;

async function getBackgroundImage() {
  if (_bgImageCache) return _bgImageCache;
  _bgImageCache = await loadImage(path.join(__dirname, "bg-soccer.jpg"));
  return _bgImageCache;
}

/**
 * Cache logo URL — tránh re-download cùng logo nhiều lần trong một phiên.
 * Key: URL string, Value: canvas Image object hoặc null (nếu load thất bại).
 */
const _logoCache = new Map();

// ─── Shared Headers ───────────────────────────────────────────────────────────

const DOWNLOAD_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
};

// ─── Image Loader ─────────────────────────────────────────────────────────────

/**
 * Load ảnh thông minh: hỗ trợ Buffer, file path, và URL HTTP.
 * - Có cache theo URL để tránh re-download.
 * - Tự động convert webp/avif/svg → PNG bằng sharp cho node-canvas.
 * @param {string|Buffer|null} src
 * @returns {Promise<import('canvas').Image|null>}
 */
async function loadImageSmart(src) {
  if (!src) return null;

  // Buffer trực tiếp
  if (Buffer.isBuffer(src)) {
    try { return await loadImage(src); } catch { return null; }
  }

  if (typeof src !== "string") return null;

  // Local file hoặc data URL
  if (!/^https?:\/\//i.test(src)) {
    try { return await loadImage(src); } catch { return null; }
  }

  // Cache hit
  if (_logoCache.has(src)) return _logoCache.get(src);

  // Download
  let rawBuffer;
  let contentType = "";
  try {
    const response = await axios.get(src, {
      responseType: "arraybuffer",
      timeout: 10000,
      headers: DOWNLOAD_HEADERS,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    rawBuffer    = Buffer.from(response.data);
    contentType  = String(response.headers?.["content-type"] || "")
      .split(";")[0].trim().toLowerCase();
  } catch {
    _logoCache.set(src, null); // caches failure — không retry vô hạn
    return null;
  }

  // Thử load trực tiếp với format node-canvas hỗ trợ natively
  const nativeFormats = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
  if (nativeFormats.includes(contentType)) {
    try {
      const img = await loadImage(rawBuffer);
      _logoCache.set(src, img);
      return img;
    } catch { /* fall-through to conversion */ }
  }

  // Convert định dạng khác (webp / avif / svg…) → PNG qua sharp
  try {
    const pngBuffer = await sharp(rawBuffer, { failOn: "none" }).png().toBuffer();
    const img = await loadImage(pngBuffer);
    _logoCache.set(src, img);
    return img;
  } catch {
    // Lần cuối: thử load buffer gốc không qua sharp
    try {
      const img = await loadImage(rawBuffer);
      _logoCache.set(src, img);
      return img;
    } catch {
      _logoCache.set(src, null);
      return null;
    }
  }
}

// ─── Canvas Helpers ───────────────────────────────────────────────────────────

/** Vẽ logo team bên trong hình tròn clip */
function drawCircleLogo(ctx, img, x, y, size) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x, y, size, size);
  }
  ctx.restore();
}

/** Vẽ text dài xuống nhiều dòng khi vượt maxWidth */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  if (!text) return;
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const testLine = line + word + " ";
    if (ctx.measureText(testLine).width > maxWidth && line !== "") {
      ctx.fillText(line.trim(), x, y);
      line = word + " ";
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line.trim()) ctx.fillText(line.trim(), x, y);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Tạo ảnh thumbnail PNG cho một trận đấu.
 * Background được cache — chỉ đọc disk lần đầu.
 * Logo home/away được load song song bằng Promise.all.
 *
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function createMatchImage(
  league, homeName, homeLogo, awayName, awayLogo, time, day, status,
) {
  const WIDTH  = 640;
  const HEIGHT = 480;
  const SCALE  = 1.2;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx    = canvas.getContext("2d");
  const cx     = WIDTH  / 2;
  const cy     = HEIGHT / 2;

  // ── Background (cached) ──
  const bg = await getBackgroundImage();
  ctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);

  // Overlay tối
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Vignette viền
  const vignette = ctx.createRadialGradient(cx, cy, 100, cx, cy, WIDTH);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // ── Layout zones ──
  const headerH       = HEIGHT * 0.25;
  const matchH        = HEIGHT * 0.50;
  const footerH       = HEIGHT * 0.25;
  const headerCenterY = headerH / 2;
  const matchCenterY  = headerH + matchH / 2;
  const footerCenterY = headerH + matchH + footerH / 1.5;

  ctx.textAlign = "center";

  // ── Header: time badge ──
  const badgeW = 175 * SCALE;
  const badgeH = 38 * SCALE;
  ctx.fillStyle = "#ff4d4f";
  ctx.beginPath();
  ctx.roundRect(cx - badgeW / 2, headerCenterY + 35 * SCALE, badgeW, badgeH, 14 * SCALE);
  ctx.fill();

  ctx.fillStyle = "#fff";
  ctx.font = `bold ${25 * SCALE}px Arial`;
  ctx.fillText(`${time ?? ""} | ${day ?? ""}`, cx, headerCenterY + 62 * SCALE);

  // ── Logos: load song song — không chờ tuần tự ──
  const [logo1, logo2] = await Promise.all([
    loadImageSmart(homeLogo),
    loadImageSmart(awayLogo),
  ]);

  const logoSize  = 120 * SCALE;
  const gap       = 100 * SCALE;
  const homeLogoX = cx - gap - logoSize;
  const awayLogoX = cx + gap;
  const logoY     = matchCenterY - logoSize / 2;

  drawCircleLogo(ctx, logo1, homeLogoX, logoY, logoSize);
  drawCircleLogo(ctx, logo2, awayLogoX, logoY, logoSize);

  // ── VS text ──
  ctx.fillStyle   = "#fff";
  ctx.font        = `italic bold ${32 * SCALE}px Georgia`;
  ctx.shadowColor = "rgba(255,255,255,0.7)";
  ctx.shadowBlur  = 18 * SCALE;
  ctx.fillText("VS", cx, matchCenterY + 12 * SCALE);
  ctx.shadowBlur  = 0;

  // ── Team names ──
  ctx.fillStyle = "#fff";
  ctx.font      = `bold ${20 * SCALE}px Arial`;
  const nameY   = logoY + logoSize + 40 * SCALE;
  wrapText(ctx, homeName ?? "", homeLogoX + logoSize / 2, nameY, 160 * SCALE, 26 * SCALE);
  wrapText(ctx, awayName ?? "", awayLogoX + logoSize / 2, nameY, 160 * SCALE, 26 * SCALE);

  // ── Footer: league name ──
  ctx.font = `bold ${20 * SCALE}px Arial`;
  ctx.fillText(league ?? "", cx, footerCenterY);

  return canvas.toBuffer("image/png");
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { createMatchImage };
