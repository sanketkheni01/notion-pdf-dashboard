const express = require("express");
const { Client } = require("@notionhq/client");
const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 4569;

// Load the Nextbase letterhead template once at startup
const TEMPLATE_PATH = path.join(__dirname, "public", "template-nextbase.html");
let LETTER_TEMPLATE = fs.readFileSync(TEMPLATE_PATH, "utf8");

// Reload template on SIGHUP (zero-downtime update)
process.on("SIGHUP", () => {
  LETTER_TEMPLATE = fs.readFileSync(TEMPLATE_PATH, "utf8");
  console.log("[template] Reloaded letterhead template");
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── helpers ──────────────────────────────────────────────────────────────────

function extractPageId(url) {
  const clean = url.trim().split("?")[0];
  const match = clean.match(/([a-f0-9]{32})$/i) || clean.match(/([a-f0-9-]{36})$/i);
  if (match) return match[1].replace(/-/g, "");
  throw new Error("Could not extract page ID from Notion URL. Make sure it ends with a 32-char ID.");
}

function richText(arr) {
  return (arr || [])
    .map((t) => {
      let s = t.plain_text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (t.annotations.bold)          s = `<strong>${s}</strong>`;
      if (t.annotations.italic)        s = `<em>${s}</em>`;
      if (t.annotations.underline)     s = `<u>${s}</u>`;
      if (t.annotations.strikethrough) s = `<s>${s}</s>`;
      if (t.annotations.code)          s = `<code style="background:#f4f4f4;padding:2px 4px;border-radius:3px;font-size:0.9em">${s}</code>`;
      return s;
    })
    .join("");
}

function blockToHtml(block) {
  const b = block[block.type];
  switch (block.type) {
    case "heading_1":          return `<h1>${richText(b.rich_text)}</h1>`;
    case "heading_2":          return `<h2>${richText(b.rich_text)}</h2>`;
    case "heading_3":          return `<h3>${richText(b.rich_text)}</h3>`;
    case "paragraph": {
      const c = richText(b.rich_text);
      return c ? `<p>${c}</p>` : "<br>";
    }
    case "bulleted_list_item": return `__BULLET__${richText(b.rich_text)}__END__`;
    case "numbered_list_item": return `__NUM__${richText(b.rich_text)}__END__`;
    case "divider":            return "<hr>";
    case "quote":              return `<blockquote>${richText(b.rich_text)}</blockquote>`;
    case "callout":            return `<div style="background:#f8f8f8;border-left:4px solid #888;padding:10px 14px;margin:8px 0">${richText(b.rich_text)}</div>`;
    default:                   return "";
  }
}

function wrapLists(parts) {
  let html = "";
  let i = 0;
  while (i < parts.length) {
    if (parts[i].startsWith("__BULLET__")) {
      html += "<ul>";
      while (i < parts.length && parts[i].startsWith("__BULLET__")) {
        html += `<li>${parts[i].replace("__BULLET__", "").replace("__END__", "")}</li>`;
        i++;
      }
      html += "</ul>";
    } else if (parts[i].startsWith("__NUM__")) {
      html += "<ol>";
      while (i < parts.length && parts[i].startsWith("__NUM__")) {
        html += `<li>${parts[i].replace("__NUM__", "").replace("__END__", "")}</li>`;
        i++;
      }
      html += "</ol>";
    } else {
      html += parts[i];
      i++;
    }
  }
  return html;
}

async function fetchAllBlocks(notion, blockId) {
  const blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    blocks.push(...res.results);
    cursor = res.next_cursor;
  } while (cursor);
  return blocks;
}

// ── routes ────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// POST /api/convert — only needs notionUrl now, template is server-side
app.post("/api/convert", async (req, res) => {
  const { notionUrl } = req.body;
  const apiKey = process.env.NOTION_API_KEY;

  if (!notionUrl) {
    return res.status(400).json({ error: "notionUrl is required." });
  }
  if (!apiKey) {
    return res.status(500).json({ error: "NOTION_API_KEY not configured on server." });
  }

  let pageId;
  try {
    pageId = extractPageId(notionUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let browser;
  try {
    const notion = new Client({ auth: apiKey });
    const blocks = await fetchAllBlocks(notion, pageId);
    const parts = blocks.map(blockToHtml).filter(Boolean);
    const contentHtml = wrapLists(parts);
    const finalHtml = LETTER_TEMPLATE.replace("{{NOTION_CONTENT}}", contentHtml);

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    // Match viewport to A4 dimensions so content fills the full page
    await page.setViewport({ width: 595, height: 842 });
    await page.setContent(finalHtml, { waitUntil: "networkidle2" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      // No page margins — the fixed header/footer divs handle spacing via CSS
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      // Display header/footer from fixed-position divs (CSS handles it)
      displayHeaderFooter: false,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="notion-${pageId.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error("[convert]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`notion-pdf-dashboard running on http://localhost:${PORT}`));
