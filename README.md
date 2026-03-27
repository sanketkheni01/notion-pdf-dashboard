# Notion → PDF Dashboard

Zero-build. Just `node server.js`.

## Stack
- Express (server + API)
- Vanilla HTML/JS (no framework)
- Puppeteer (PDF render)
- @notionhq/client (Notion API)

## Run

```bash
bun install   # or npm install
node server.js
# → http://localhost:3456
```

## HTML Template Format

Your template must include `{{NOTION_CONTENT}}` exactly where the Notion content should appear:

```html
<!DOCTYPE html>
<html>
<body>
  <div class="header"><!-- letterhead --></div>
  {{NOTION_CONTENT}}
  <div class="footer"><!-- footer --></div>
</body>
</html>
```

## Notion Setup

1. Go to https://www.notion.so/my-integrations → Create integration → copy secret
2. Open each Notion page → `...` → Connections → Add your integration

## Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create notion-pdf
```

`~/.cloudflared/config.yml`:
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: pdf.yourdomain.com
    service: http://localhost:3456
  - service: http_status:404
```

```bash
cloudflared tunnel route dns notion-pdf pdf.yourdomain.com
cloudflared tunnel run notion-pdf
```

## API

### POST /api/convert
```json
{ "notionUrl": "...", "apiKey": "secret_...", "htmlTemplate": "...{{NOTION_CONTENT}}..." }
```
→ Returns PDF blob

### GET /api/health
→ `{ "status": "ok", "timestamp": "..." }`
