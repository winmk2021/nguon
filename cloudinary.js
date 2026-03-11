const { v2: cloudinary } = require("cloudinary");
const { Readable } = require("stream"); // Node built-in thay thế streamifier lỗi thời
require("dotenv").config();

// ─── Config & Validation ──────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Kiểm tra config một lần khi module load — không phải mỗi lần gọi hàm
const MISSING_CONFIG = [
  ["CLOUDINARY_CLOUD_NAME", process.env.CLOUDINARY_CLOUD_NAME],
  ["CLOUDINARY_API_KEY",    process.env.CLOUDINARY_API_KEY],
  ["CLOUDINARY_API_SECRET", process.env.CLOUDINARY_API_SECRET],
]
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (MISSING_CONFIG.length > 0) {
  throw new Error(
    `Missing Cloudinary config: ${MISSING_CONFIG.join(", ")}. Set them in .env or environment variables.`
  );
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

function getCloudinaryErrorMessage(error) {
  if (!error) return "Unknown Cloudinary error";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  const nested =
    error?.error?.message ??
    error?.response?.data?.error?.message ??
    error?.response?.data?.message;
  if (nested) return String(nested);
  try { return JSON.stringify(error); } catch { return String(error); }
}

function isNotFoundError(error) {
  const httpCode =
    error?.http_code ??
    error?.error?.http_code ??
    error?.response?.status ??
    error?.statusCode;
  if (httpCode === 404) return true;
  const msg = getCloudinaryErrorMessage(error);
  return typeof msg === "string" && /resource not found/i.test(msg);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Kiểm tra ảnh đã tồn tại trên Cloudinary chưa.
 * Trả về secure_url nếu có, null nếu chưa.
 */
async function checkImageExists(publicId) {
  try {
    const result = await cloudinary.api.resource(`matches/${publicId}`);
    return result.secure_url;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw new Error(getCloudinaryErrorMessage(error));
  }
}

/**
 * Upload ảnh từ Buffer lên Cloudinary.
 * Tự động dùng cache nếu ảnh đã tồn tại — tránh upload trùng lặp.
 */
async function uploadImage(buffer, publicId) {
  const cachedUrl = await checkImageExists(publicId);
  if (cachedUrl) {
    console.log(`📦 Cached: ${publicId}`);
    return cachedUrl;
  }

  console.log(`☁️  Uploading: ${publicId}`);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "matches", public_id: publicId, overwrite: true },
      (error, result) => {
        if (error) return reject(new Error(getCloudinaryErrorMessage(error)));
        resolve(result.secure_url);
      },
    );

    // Dùng Node.js built-in Readable.from() thay vì package streamifier lỗi thời (2014)
    Readable.from(buffer).pipe(stream);
  });
}

/**
 * Xóa ảnh Cloudinary không còn dùng nữa.
 * @param {string[]} validIds - Danh sách public_id CẦN GIỮ LẠI (không bao gồm prefix "matches/")
 */
async function deleteOldImages(validIds) {
  if (!Array.isArray(validIds)) {
    throw new Error("deleteOldImages(validIds) expects an array");
  }

  // Lấy toàn bộ ảnh trong folder matches/ theo từng trang
  const allPublicIds = [];
  let nextCursor;
  do {
    let result;
    try {
      result = await cloudinary.api.resources({
        type: "upload",
        prefix: "matches/",
        max_results: 500,
        next_cursor: nextCursor,
      });
    } catch (error) {
      throw new Error(getCloudinaryErrorMessage(error));
    }
    allPublicIds.push(...(result?.resources ?? []).map((r) => r.public_id));
    nextCursor = result?.next_cursor;
  } while (nextCursor);

  const keepSet = new Set(validIds.map((id) => `matches/${id}`));
  const toDelete = allPublicIds.filter((pid) => !keepSet.has(pid));

  if (toDelete.length === 0) {
    console.log("🧹 No old images to delete.");
    return;
  }

  console.log(`🗑️  Deleting ${toDelete.length} old image(s)...`);

  // Xóa theo batch 100 (giới hạn của Cloudinary API)
  const BATCH_SIZE = 100;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const batch = toDelete.slice(i, i + BATCH_SIZE);
    try {
      await cloudinary.api.delete_resources(batch);
    } catch (error) {
      throw new Error(getCloudinaryErrorMessage(error));
    }
  }
}

module.exports = { uploadImage, deleteOldImages };
