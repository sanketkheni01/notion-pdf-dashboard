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
    case "to_do": {
      const checked = b.checked ? ' checked' : '';
      return `<div class="todo-item"><div class="todo-check${checked}"></div><span>${richText(b.rich_text)}</span></div>`;
    }
    case "code": {
      const code = richText(b.rich_text);
      return `<pre>${code}</pre>`;
    }
    case "image": {
      const url = b.type === "file" ? b.file.url : b.external?.url;
      const caption = b.caption?.length ? `<figcaption>${richText(b.caption)}</figcaption>` : '';
      return url ? `<figure class="notion-image"><img src="${url}" />${caption}</figure>` : '';
    }
    case "table":              return `__TABLE_START_${block.id}__`;
    case "table_row": {
      const cells = b.cells.map(c => `<td>${richText(c)}</td>`).join('');
      return `__TROW__${cells}__ENDTROW__`;
    }
    case "bookmark":           return b.url ? `<p><a href="${b.url}" style="color:#525252">${b.url}</a></p>` : '';
    case "toggle": {
      return `<p><strong>${richText(b.rich_text)}</strong></p>`;
    }
    case "__table_end":        return "__TABLE_END__";
    default:                   return "";
  }
}

function wrapLists(parts) {
  let html = "";
  let i = 0;
  let firstTableRow = true;
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
    } else if (parts[i].startsWith("__TABLE_START_")) {
      html += "<table>";
      firstTableRow = true;
      i++;
    } else if (parts[i].startsWith("__TROW__")) {
      const cells = parts[i].replace("__TROW__", "").replace("__ENDTROW__", "");
      if (firstTableRow) {
        html += `<tr>${cells.replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>")}</tr>`;
        firstTableRow = false;
      } else {
        html += `<tr>${cells}</tr>`;
      }
      i++;
    } else if (parts[i] === "__TABLE_END__") {
      html += "</table>";
      i++;
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
    for (const block of res.results) {
      blocks.push(block);
      // Fetch children for tables and toggles
      if (block.has_children && (block.type === "table" || block.type === "toggle")) {
        const children = await fetchAllBlocks(notion, block.id);
        blocks.push(...children);
        if (block.type === "table") blocks.push({ type: "__table_end", __table_end: {} });
      }
    }
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

    const logoB64 = "PHN2ZyB2aWV3Qm94PSIwIDAgNDMgNDMiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTIxLjMyNTcgMEMzMy4xMDM2IDAgNDIuNjUxNSA5LjU0Nzk3IDQyLjY1MTUgMjEuMzI1OEM0Mi42NTE1IDMzLjEwMzcgMzMuMTAzNiA0Mi42NTE1IDIxLjMyNTcgNDIuNjUxNUM5LjU0Nzg4IDQyLjY1MTUgMCAzMy4xMDM3IDAgMjEuMzI1OEMxLjExNDY3ZS0wNSA5LjU0Nzk2IDkuNTQ3ODggMCAyMS4zMjU3IDBaTTkuNjg2OTMgMjEuMjgxN0wyMS4yNjYgMjAuNTE5OEwyNi42MDE2IDMxLjIyODJWMTEuNTE4NEw5LjY4NjkzIDIxLjI4MTdaIiBmaWxsPSIjMEEwQTBBIi8+PC9zdmc+";

    const headerTemplate = `
      <div style="width:100%;padding:14px 40px 0;font-size:10px;">
        <div style="display:flex;align-items:center;height:50px;">
          <img src="data:image/svg+xml;base64,${logoB64}" style="width:36px;height:36px;margin-right:8px;" />
          <div>
            <div style="font-family:Arial,sans-serif;font-size:20px;font-weight:bold;color:#0a0a0a;letter-spacing:-0.3px;">Nextbase</div>
            <div style="font-family:Arial,sans-serif;font-size:7px;font-weight:500;color:#525252;">Solutions Private Limited</div>
          </div>
        </div>
        <div style="margin-top:4px;height:1px;background:#e5e5e5;"></div>
      </div>
    `;

    const footerTemplate = `
      <div style="width:100%;padding:0 40px;font-size:10px;font-family:Arial,sans-serif;">
        <div style="height:1px;background:#e5e5e5;margin-bottom:8px;"></div>
        <div style="color:#525252;font-size:8px;margin-bottom:4px;">✉ contact@nextbase.solutions</div>
        <div style="color:#525252;font-size:8px;margin-bottom:4px;">☎ +91 94271 36629</div>
        <div style="color:#525252;font-size:8px;margin-bottom:4px;">⊕ www.nextbase.solutions</div>
        <div style="height:1px;background:#e5e5e5;margin:4px 0;"></div>
        <div style="color:#525252;font-size:8px;">⊙ 505 RIO Business Hub, Beside KBC 2, Yamuna Chowk, Mota Varachha, Surat, Gujarat 394101.</div>
      </div>
    `;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setContent(finalHtml, { waitUntil: "networkidle2" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "100px", right: "0", bottom: "110px", left: "0" },
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
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
