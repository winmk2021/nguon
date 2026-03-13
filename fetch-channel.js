const { createMatchImage } = require("./logo.js");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { uploadImage, deleteOldImages } = require("./cloudinary.js");

// ─── Constants ────────────────────────────────────────────────────────────────

const CANDIDATE_DOMAINS = [
  "https://hoadaotv.net",
  "https://hoadao1.tv",
  "https://hoadaotv.info",
  "https://hoadaotv.me",
  "https://hoadaotv.org"
];

let DOMAIN = CANDIDATE_DOMAINS[0];

/** Tái sử dụng headers thay vì lặp lại ở nhiều nơi */
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

/** Số request scrapelink() tối đa chạy song song — tránh bị block bởi server nguồn */
const SCRAPE_CONCURRENCY = 5;

/** Số upload Cloudinary tối đa cho song song — tránh rate limit */
const UPLOAD_CONCURRENCY = 3;

/** Các key stream được phép nhận từ nguồn — whitelist */
const ALLOWED_STREAM_KEYS = ["ndsd", "hd", "sd", "fullhd", "flv", "flv2"];

/** Mapping key → tên hiển thị trong MonPlayer */
const STREAM_LABEL_MAP = {
  ndsd:   "Nhà đài",
  hd:     "HD",
  sd:     "SD",
  fullhd: "FullHD",
  flv:    "FL",
  flv2:   "FLV2",
};

/** Nhãn trạng thái trận đấu */
const STATUS_CONFIG = {
  "Hiệp 1":        { text: "● Live",     color: "#FF0000" },
  "Hiệp 2":        { text: "● Live",     color: "#FF0000" },
  "Chưa Bắt Đầu":  { text: "● Upcoming", color: "#FF9800" },
  "Đã Kết Thúc":   { text: "● Fulltime", color: "#9E9E9E" },
};

const DEFAULT_STATUS = { text: "● Live", color: "#FF0000" };

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Chuyển URL tương đối thành URL tuyệt đối */
function absolutizeUrl(url, domain) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${domain}${url}`;
  return url;
}

/** Sinh random ID dùng crypto (không dùng Math.random) */
function generateId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

/** ID kênh ổn định từ match URL — dùng slug thay random để tránh trùng lặp */
function stableChannelId(matchLink) {
  const slug = matchLink.split("/").pop();
  return "ch-" + slug.replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Validate và sanitize dữ liệu stream parse từ HTML nguồn ngoài.
 * Chỉ chấp nhận key đã whitelist với URL http/https hợp lệ, độ dài ≤ 1024.
 * @returns {object|null} Object đã sanitize, hoặc null nếu không hợp lệ
 */
function validateStreamLinks(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const sanitized = {};
  for (const key of ALLOWED_STREAM_KEYS) {
    const val = obj[key];
    if (!val || typeof val !== "string") continue;
    if (!/^https?:\/\//i.test(val)) continue;
    if (val.length > 1024) continue;
    sanitized[key] = val;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/**
 * Tạo một object stream_link chuẩn MonPlayer.
 * Trả null nếu url rỗng — tránh push link không có URL vào output.
 */
function makeStreamLink(name, url, referer) {
  if (!url) return null;
  return {
    id: generateId("lnk"),
    name,
    type: "hls",
    default: true,
    url,
    request_headers: [
      { key: "Referer",    value: referer },
      { key: "User-Agent", value: "Mozilla/5.0" },
    ],
  };
}

/**
 * Chạy danh sách async task song song với giới hạn số lượng concurrency.
 * Đảm bảo index-safe: mỗi task chỉ chạy một lần, thứ tự kết quả giữ nguyên.
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
  return results;
}

// ─── Scraping ─────────────────────────────────────────────────────────────────

/**
 * Crawl một trang trận đấu, trích xuất object serverStreamLinks từ HTML.
 * @returns {object|null} Stream links đã validate, hoặc null
 */
async function scrapelink(link) {
  try {
    const { data: html } = await axios.get(link, {
      headers: DEFAULT_HEADERS,
      maxContentLength: 5 * 1024 * 1024,
      timeout: 15000,
    });

    const match = html.match(/const\s+serverStreamLinks\s*=\s*({.*?});/s);
    if (!match?.[1]) return null;

    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      console.error(`❌ JSON Parse Error for ${link}`);
      return null;
    }

    const validated = validateStreamLinks(parsed);
    if (!validated) console.error(`❌ Invalid stream data for ${link}`);
    return validated;
  } catch (error) {
    console.error(`❌ Error scraping ${link}:`, error.message);
    return null;
  }
}

/**
 * Tìm kiếm domain hoadaotv nào đang hoạt động bằng cách thử từng domain
 * trong CANDIDATE_DOMAINS.
 * @returns {string|null} Domain đang hoạt động, hoặc null nếu không có
 */
async function findActiveDomain() {
  for (const url of CANDIDATE_DOMAINS) {
    try {
      console.log(`🔍 Checking domain: ${url}...`);
      const testUrl = `${url}/soccer`;
      const { data, status } = await axios.get(testUrl, {
        headers: DEFAULT_HEADERS,
        timeout: 8000,
        validateStatus: () => true // parse mọi status
      });
      // Kiểm tra có dữ liệu trang trận đấu hay không (dùng content có .cm-wrap)
      if (status === 200 && data && data.includes('cm-wrap')) {
        console.log(`✅ Found active domain: ${url}`);
        return url;
      } else {
        console.log(`❌ Domain ${url} returned invalid content or status (Status: ${status}).`);
      }
    } catch (error) {
      console.log(`❌ Domain ${url} is unreachable (${error.message}).`);
    }
  }
  return null;
}

/**
 * Crawl trang soccer chính, parse metadata của tất cả trận, và scrape stream
 * links song song với giới hạn SCRAPE_CONCURRENCY.
 * @returns {Array<MatchData>} Danh sách trận kèm stream links
 */
async function scrapeSoccer() {
  const url = `${DOMAIN}/soccer`;
  console.log(`🚀 Fetching ${url}...`);

  let html;
  try {
    const { data } = await axios.get(url, {
      headers: DEFAULT_HEADERS,
      maxContentLength: 10 * 1024 * 1024,
      timeout: 15000,
    });
    html = data;
  } catch (error) {
    console.error("❌ Error fetching soccer page:", error.message);
    return [];
  }

  const $ = cheerio.load(html);
  const cards = $(".cm-wrap").toArray();
  console.log(`✅ Found ${cards.length} match cards`);

  // Parse background URL một lần từ card đầu tiên
  const firstCard = $(".card-match").first();
  const bgStyle   = firstCard.find(".card-bg-blur").attr("style");
  let backgroundUrl = null;
  if (bgStyle) {
    const bgMatch = bgStyle.match(/url\((.*?)\)/);
    if (bgMatch?.[1]) {
      backgroundUrl = bgMatch[1].startsWith("/")
        ? `${DOMAIN}${bgMatch[1]}`
        : bgMatch[1];
    }
  }

  // Parse metadata đồng bộ (không cần await) — nhanh vì chỉ đọc DOM
  const matchMeta = cards.map((el) => {
    const card      = $(el);
    const matchPath = card.find(".match-link-overlay").attr("href");
    if (!matchPath) return null;

    return {
      home:       card.find(".team-home .name-short").text().trim(),
      away:       card.find(".team-away .name-short").text().trim(),
      time:       card.find(".time span").eq(0).text().trim(),
      date:       card.find(".time span").eq(1).text().trim(),
      league:     card.find(".league").text().trim(),
      status:     card.find(".text-timeinplay").text().trim(),
      leagueIcon: absolutizeUrl(card.find(".corner img").attr("src"), DOMAIN),
      homeIcon:   absolutizeUrl(card.find(".team-home .base-icon img").attr("data-src"), DOMAIN),
      awayIcon:   absolutizeUrl(card.find(".team-away .base-icon img").attr("src"), DOMAIN),
      matchLink:  matchPath.startsWith("http") ? matchPath : `${DOMAIN}${matchPath}`,
      backUrl:    backgroundUrl,
    };
  }).filter(Boolean);

  // Hỗ trợ TEST_LINK qua env var (thay cho hardcode cũ)
  if (process.env.TEST_LINK) {
    const raw = process.env.TEST_LINK.trim();
    if (raw && !matchMeta.some((m) => m.matchLink.endsWith(raw))) {
      const testUrl = raw.startsWith("http") ? raw : `${DOMAIN}${raw}`;
      matchMeta.unshift({
        home: "Test", away: "Test", time: "", date: "", league: "", status: "",
        leagueIcon: null, homeIcon: null, awayIcon: null,
        matchLink: testUrl, backUrl: backgroundUrl,
      });
      console.log(`ℹ️  Injected TEST_LINK: ${testUrl}`);
    }
  }

  // Scrape stream links tất cả trận song song (concurrency giới hạn SCRAPE_CONCURRENCY)
  console.log(`\n🔗 Scraping ${matchMeta.length} matches (concurrency=${SCRAPE_CONCURRENCY})...`);

  const scrapeTasks = matchMeta.map((meta) => async () => {
    console.log(`  → ${meta.home} vs ${meta.away}`);
    const streams = await scrapelink(meta.matchLink);
    return { ...meta, streams: streams ?? {} };
  });

  const matches = await runWithConcurrency(scrapeTasks, SCRAPE_CONCURRENCY);

  const hasStream = matches.some((m) => Object.keys(m.streams).length > 0);
  if (!hasStream) console.log("⚠️  No stream links found.");

  return matches;
}

// ─── Channel Builder ──────────────────────────────────────────────────────────

/** Tạo danh sách stream_link — bỏ qua URL rỗng/null */
function buildStreamLinks(streams, referer) {
  return ALLOWED_STREAM_KEYS
    .map((key) => makeStreamLink(STREAM_LABEL_MAP[key], streams[key], referer))
    .filter(Boolean);
}

/**
 * Tạo object channel chuẩn MonPlayer từ dữ liệu một trận đấu.
 * @param {object} item    - MatchData (home, away, homeIcon, awayIcon, matchLink, streams…)
 * @param {string} channelId
 * @param {string} imageUrl - URL ảnh thumbnail đã upload Cloudinary
 */
function buildChannel(item, channelId, imageUrl) {
  const labelStatus = STATUS_CONFIG[item.status] ?? DEFAULT_STATUS;

  return {
    id:   channelId,
    name: `${item.home} vs ${item.away}`,
    labels: [{
      position:   "top-left",
      ...labelStatus,
      text_color: "#FFFFFF",
      font_size:  8,
    }],
    image: {
      url:     imageUrl,
      height:  480,
      width:   640,
      display: "cover",
    },
    type:    "single",
    display: "overlay",
    sources: [{
      id:   generateId("src"),
      name: `${item.home} - ${item.away}`,
      contents: [{
        id:   generateId("ct"),
        name: item.league || "",
        streams: [{
          id:   generateId("st"),
          name: "Stream",
          stream_links: buildStreamLinks(item.streams, item.matchLink),
        }],
      }],
    }],
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log("🏁 Starting Scraper...\n");

  const activeDomain = await findActiveDomain();
  if (activeDomain) {
    DOMAIN = activeDomain;
  } else {
    console.log(`⚠️ Could not find an active domain among candidates. Proceeding with default: ${DOMAIN}`);
  }

  const list = await scrapeSoccer();
  console.log(`\n📊 Scraping done. Total matches: ${list.length}`);

  if (list.length === 0) {
    console.log("⚠️  No data to process. (Matches might not have started yet)");
    return;
  }

  // ── Đọc và validate template.json ──
  const templatePath = path.join(__dirname, "template.json");
  if (!fs.existsSync(templatePath)) {
    console.error(`❌ template.json not found at ${templatePath}`);
    process.exitCode = 1;
    return;
  }

  let templateData;
  try {
    templateData = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  } catch (e) {
    console.error(`❌ Failed to parse template.json: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  if (!templateData || typeof templateData !== "object" || Array.isArray(templateData)) {
    console.error("❌ template.json has invalid root structure (expected object)");
    process.exitCode = 1;
    return;
  }

  try {
    // Map dùng để dedup theo channelId trong O(1) — thay thế channels.some() O(n²)
    const channelMap = new Map();
    const uploadedIds = [];

    // Tạo ảnh + upload Cloudinary song song, giới hạn UPLOAD_CONCURRENCY
    console.log(`\n🖼️  Creating & uploading images (concurrency=${UPLOAD_CONCURRENCY})...`);

    const uploadTasks = list.map((item) => async () => {
      const channelId = stableChannelId(item.matchLink);
      if (channelMap.has(channelId)) return; // Bỏ qua duplicate

      const imageId = channelId.replace("ch-", "img-");

      // Tạo ảnh thumbnail (logo load song song bên trong createMatchImage)
      const buffer = await createMatchImage(
        item.league,
        item.home,
        item.homeIcon,
        item.away,
        item.awayIcon,
        item.time,
        item.date,
        item.status,
      );

      const imageUrl = await uploadImage(buffer, imageId);
      uploadedIds.push(imageId);

      channelMap.set(channelId, buildChannel(item, channelId, imageUrl));
    });

    await runWithConcurrency(uploadTasks, UPLOAD_CONCURRENCY);

    const channels = [...channelMap.values()];

    // Xóa ảnh Cloudinary không còn được dùng
    await deleteOldImages(uploadedIds);

    // Ghi nhận domain cuối vào template
    templateData.url = DOMAIN;
    if (templateData.share) {
      templateData.share.url = DOMAIN;
    }

    // Ghi channels.json
    if (!templateData.groups) templateData.groups = [{}];
    templateData.groups[0].channels = channels;

    const outputPath = path.join(__dirname, "channels.json");
    fs.writeFileSync(outputPath, JSON.stringify(templateData, null, 4));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Done in ${elapsed}s — ${channels.length} channels written to channels.json`);
  } catch (error) {
    const msg = error?.message ?? String(error) ?? "Unknown error";
    console.error("❌ Error generating channels.json:", msg);
    if (error?.stack) console.error(error.stack);
    process.exitCode = 1;
  }
}

main();
