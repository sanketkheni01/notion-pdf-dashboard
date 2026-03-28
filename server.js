const express = require("express");
const { Client } = require("@notionhq/client");
const puppeteer = require("puppeteer");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 4569;
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Load assets at startup ──────────────────────────────────────────
const FONTS_DIR = path.join(__dirname, "fonts");
const ASSETS_DIR = path.join(__dirname, "assets");

const poppinsSemiBoldBytes = fs.readFileSync(path.join(FONTS_DIR, "Poppins-SemiBold.ttf"));
const poppinsMediumBytes = fs.readFileSync(path.join(FONTS_DIR, "Poppins-Medium.ttf"));
const geistRegularBytes = fs.readFileSync(path.join(FONTS_DIR, "Geist-Regular.ttf"));
const logoPng = fs.readFileSync(path.join(ASSETS_DIR, "logo.png"));
const emailIconPng = fs.readFileSync(path.join(ASSETS_DIR, "email-icon.png"));
const phoneIconPng = fs.readFileSync(path.join(ASSETS_DIR, "phone-icon.png"));
const webIconPng = fs.readFileSync(path.join(ASSETS_DIR, "web-icon.png"));
const pinIconPng = fs.readFileSync(path.join(ASSETS_DIR, "pin-icon.png"));

// ── Notion block → HTML ─────────────────────────────────────────────
function richTextToHtml(richTexts) {
  if (!richTexts) return "";
  return richTexts
    .map((t) => {
      let s = t.plain_text || "";
      s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (t.annotations?.bold) s = `<strong>${s}</strong>`;
      if (t.annotations?.italic) s = `<em>${s}</em>`;
      if (t.annotations?.underline) s = `<u>${s}</u>`;
      if (t.annotations?.strikethrough) s = `<s>${s}</s>`;
      if (t.annotations?.code) s = `<code>${s}</code>`;
      if (t.annotations?.color && t.annotations.color !== "default") {
        const c = t.annotations.color;
        if (c.endsWith("_background")) {
          s = `<mark style="background:${colorMap(c)}">${s}</mark>`;
        } else {
          s = `<span style="color:${colorMap(c)}">${s}</span>`;
        }
      }
      if (t.href) s = `<a href="${t.href}">${s}</a>`;
      return s;
    })
    .join("");
}

function colorMap(c) {
  const map = {
    gray: "#9b9b9b", brown: "#64473a", orange: "#d9730d", yellow: "#dfab01",
    green: "#0f7b6c", blue: "#0b6e99", purple: "#6940a5", pink: "#ad1a72", red: "#e03e3e",
    gray_background: "#ebeced", brown_background: "#e9e5e3", orange_background: "#fbecdd",
    yellow_background: "#fbf3db", green_background: "#ddedea", blue_background: "#ddebf1",
    purple_background: "#eae4f2", pink_background: "#f4dfeb", red_background: "#fbe4e4",
  };
  return map[c] || "#0a0a0a";
}

function blockToHtml(block) {
  const t = block.type;
  const data = block[t];
  if (!data) return "";

  switch (t) {
    case "paragraph":
      return `<p>${richTextToHtml(data.rich_text)}</p>`;
    case "heading_1":
      return `<h1>${richTextToHtml(data.rich_text)}</h1>`;
    case "heading_2":
      return `<h2>${richTextToHtml(data.rich_text)}</h2>`;
    case "heading_3":
      return `<h3>${richTextToHtml(data.rich_text)}</h3>`;
    case "bulleted_list_item":
      return `<__bli__>${richTextToHtml(data.rich_text)}</__bli__>`;
    case "numbered_list_item":
      return `<__nli__>${richTextToHtml(data.rich_text)}</__nli__>`;
    case "divider":
      return "<hr>";
    case "quote":
      return `<blockquote>${richTextToHtml(data.rich_text)}</blockquote>`;
    case "callout":
      const emoji = data.icon?.emoji || "💡";
      return `<div class="callout"><span class="callout-icon">${emoji}</span><div>${richTextToHtml(data.rich_text)}</div></div>`;
    case "code":
      return `<pre><code>${richTextToHtml(data.rich_text)}</code></pre>`;
    case "to_do":
      const checked = data.checked ? "checked" : "";
      return `<div class="todo-item"><input type="checkbox" ${checked} disabled /><span>${richTextToHtml(data.rich_text)}</span></div>`;
    case "image": {
      const url = data.file?.url || data.external?.url || "";
      const caption = data.caption ? richTextToHtml(data.caption) : "";
      return `<figure class="notion-image"><img src="${url}" />${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    }
    case "table_row":
      return `<tr>${(data.cells || []).map((c) => `<td>${richTextToHtml(c)}</td>`).join("")}</tr>`;
    case "table":
      return ""; // table rows are children, handled by fetchAllBlocks
    case "bookmark":
      return `<p><a href="${data.url}">${data.url}</a></p>`;
    case "toggle":
      return `<details><summary>${richTextToHtml(data.rich_text)}</summary></details>`;
    default:
      return "";
  }
}

function wrapLists(parts) {
  let html = parts.join("\n");
  html = html.replace(/(<__bli__>.*?<\/__bli__>\n?)+/g, (m) =>
    "<ul>" + m.replace(/<\/?__bli__>/g, (t) => (t === "<__bli__>" ? "<li>" : "</li>")) + "</ul>"
  );
  html = html.replace(/(<__nli__>.*?<\/__nli__>\n?)+/g, (m) =>
    "<ol>" + m.replace(/<\/?__nli__>/g, (t) => (t === "<__nli__>" ? "<li>" : "</li>")) + "</ol>"
  );
  // Wrap table rows
  html = html.replace(/(<tr>.*?<\/tr>\s*)+/g, (m) => `<table>${m}</table>`);
  return html;
}

async function fetchAllBlocks(notion, blockId) {
  let blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  // Fetch table children
  const expanded = [];
  for (const b of blocks) {
    expanded.push(b);
    if (b.type === "table" && b.has_children) {
      const children = await fetchAllBlocks(notion, b.id);
      expanded.push(...children);
    }
  }
  return expanded;
}

// ── Content-only HTML template ──────────────────────────────────────
const CONTENT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Geist:wght@400&display=swap" rel="stylesheet" />
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 100%;
      background: #fff;
      font-family: 'Geist', 'Inter', Arial, sans-serif;
      color: #0a0a0a;
      font-size: 11pt;
      line-height: 1.75;
      padding: 0 40px;
    }
    h1, h2, h3 { font-family: 'Poppins', sans-serif; color: #0a0a0a; page-break-after: avoid; }
    p, li, blockquote { orphans: 3; widows: 3; }
    h1 { font-size: 16pt; margin: 14pt 0 6pt; font-weight: 600; }
    h2 { font-size: 13pt; margin: 12pt 0 5pt; font-weight: 600; border-bottom: 1px solid #e5e5e5; padding-bottom: 3pt; }
    h3 { font-size: 11pt; margin: 10pt 0 4pt; font-weight: 600; }
    p { margin-bottom: 8pt; }
    ul, ol { margin: 6pt 0 8pt 20pt; }
    li { margin-bottom: 3pt; }
    hr { border: none; border-top: 1px solid #e5e5e5; margin: 10pt 0; }
    blockquote { border-left: 3px solid #e5e5e5; padding: 8pt 14pt; margin: 8pt 0; color: #333; background: #fafafa; font-style: italic; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    code { background: #f0f0f0; padding: 1pt 4pt; border-radius: 3px; font-size: 10pt; }
    pre { background: #f5f5f5; padding: 10pt; border-radius: 4px; margin: 8pt 0; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    table { width: 100%; border-collapse: collapse; margin: 8pt 0; }
    th, td { border: 1px solid #ddd; padding: 6pt 8pt; text-align: left; font-size: 10pt; }
    th { background: #f5f5f5; font-weight: 600; }
    .callout { display: flex; gap: 8pt; padding: 10pt; background: #f9f9f9; border-radius: 4px; margin: 8pt 0; }
    .callout-icon { font-size: 14pt; }
    .todo-item { display: flex; align-items: center; gap: 6pt; margin: 4pt 0; }
    .notion-image { margin: 8pt 0; text-align: center; }
    .notion-image img { max-width: 100%; }
    .notion-image figcaption { font-size: 9pt; color: #666; margin-top: 4pt; }
    a { color: #0b6e99; text-decoration: none; }
    mark { padding: 1pt 2pt; border-radius: 2px; }
  </style>
</head>
<body>
{{NOTION_CONTENT}}
</body>
</html>`;

// ── pdf-lib: stamp header & footer on every page ────────────────────
async function stampHeaderFooter(pdfBytes) {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.registerFontkit(fontkit);

  // Embed fonts
  const poppinsSemiBold = await pdfDoc.embedFont(poppinsSemiBoldBytes);
  const poppinsMedium = await pdfDoc.embedFont(poppinsMediumBytes);
  const geist = await pdfDoc.embedFont(geistRegularBytes);

  // Embed images
  const logo = await pdfDoc.embedPng(logoPng);
  const emailIcon = await pdfDoc.embedPng(emailIconPng);
  const phoneIcon = await pdfDoc.embedPng(phoneIconPng);
  const webIcon = await pdfDoc.embedPng(webIconPng);
  const pinIcon = await pdfDoc.embedPng(pinIconPng);

  const pages = pdfDoc.getPages();
  const darkColor = rgb(0.04, 0.04, 0.04);      // #0a0a0a
  const grayColor = rgb(0.32, 0.32, 0.32);      // #525252
  const lineColor = rgb(0.898, 0.898, 0.898);   // #e5e5e5

  for (const page of pages) {
    const { width, height } = page.getSize();
    const marginX = 40;

    // ── HEADER ──
    // Logo
    const logoSize = 30;
    const logoX = marginX;
    const logoY = height - 20 - logoSize;
    page.drawImage(logo, { x: logoX, y: logoY, width: logoSize, height: logoSize });

    // "Nextbase" text
    const titleX = logoX + logoSize + 8;
    const titleY = logoY + 14;
    page.drawText("Nextbase", {
      x: titleX, y: titleY,
      size: 18,
      font: poppinsSemiBold,
      color: darkColor,
    });

    // "Solutions Private Limited" subtitle
    page.drawText("Solutions Private Limited", {
      x: titleX, y: titleY - 12,
      size: 6.5,
      font: poppinsMedium,
      color: grayColor,
    });

    // Header divider line
    const headerLineY = logoY - 8;
    page.drawLine({
      start: { x: marginX, y: headerLineY },
      end: { x: width - marginX, y: headerLineY },
      thickness: 0.75,
      color: lineColor,
    });

    // ── FOOTER ──
    const footerTop = 95; // y position of footer divider
    const iconSize = 9;
    const footerFontSize = 7.5;
    const lineSpacing = 14;

    // Footer top divider
    page.drawLine({
      start: { x: marginX, y: footerTop },
      end: { x: width - marginX, y: footerTop },
      thickness: 0.75,
      color: lineColor,
    });

    // Row 1: Email
    let rowY = footerTop - 14;
    page.drawImage(emailIcon, { x: marginX, y: rowY - 2, width: iconSize, height: iconSize });
    page.drawText("contact@nextbase.solutions", {
      x: marginX + iconSize + 5, y: rowY,
      size: footerFontSize, font: geist, color: grayColor,
    });

    // Row 2: Phone
    rowY -= lineSpacing;
    page.drawImage(phoneIcon, { x: marginX, y: rowY - 2, width: iconSize, height: iconSize });
    page.drawText("+91 94271 36629", {
      x: marginX + iconSize + 5, y: rowY,
      size: footerFontSize, font: geist, color: grayColor,
    });

    // Row 3: Website
    rowY -= lineSpacing;
    page.drawImage(webIcon, { x: marginX, y: rowY - 2, width: iconSize, height: iconSize });
    page.drawText("www.nextbase.solutions", {
      x: marginX + iconSize + 5, y: rowY,
      size: footerFontSize, font: geist, color: grayColor,
    });

    // Thin divider before address
    rowY -= 7;
    page.drawLine({
      start: { x: marginX, y: rowY },
      end: { x: width - marginX, y: rowY },
      thickness: 0.5,
      color: lineColor,
    });

    // Row 4: Address
    rowY -= 12;
    page.drawImage(pinIcon, { x: marginX, y: rowY - 2, width: iconSize, height: iconSize });
    page.drawText("505 RIO Business Hub, Beside KBC 2, Yamuna Chowk, Mota Varachha, Surat, Gujarat 394101.", {
      x: marginX + iconSize + 5, y: rowY,
      size: footerFontSize, font: geist, color: grayColor,
    });
  }

  return await pdfDoc.save();
}

// ── Routes ──────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.post("/api/convert", async (req, res) => {
  const { notionUrl } = req.body;
  if (!notionUrl) return res.status(400).json({ error: "notionUrl required" });

  const pageId = notionUrl.replace(/-/g, "").match(/([a-f0-9]{32})/)?.[1];
  if (!pageId) return res.status(400).json({ error: "Invalid Notion URL" });

  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "NOTION_API_KEY not configured" });

  let browser;
  try {
    const notion = new Client({ auth: apiKey });
    const blocks = await fetchAllBlocks(notion, pageId);
    const parts = blocks.map(blockToHtml).filter(Boolean);
    const contentHtml = wrapLists(parts);
    const finalHtml = CONTENT_TEMPLATE.replace("{{NOTION_CONTENT}}", contentHtml);

    // Step 1: Puppeteer renders content-only PDF with reserved margins
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setContent(finalHtml, { waitUntil: "networkidle2" });

    const rawPdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: "80px", right: "0", bottom: "105px", left: "0" },
    });

    await browser.close();
    browser = null;

    // Step 2: pdf-lib stamps header & footer on every page
    const finalPdf = await stampHeaderFooter(rawPdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="notion-${pageId.slice(0, 8)}.pdf"`);
    res.send(Buffer.from(finalPdf));
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error("[convert]", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`notion-pdf-dashboard running on http://localhost:${PORT}`));
