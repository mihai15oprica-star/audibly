# WCAG Accessibility Scanner

Node.js CLI tool. Scans any URL for WCAG 2.1 AA violations using Playwright + axe-core. Generates a PDF report with score, verdict, and per-violation fix guidance.

## Install

```bash
npm install
```

> Playwright will auto-download Chromium on install.

## Web UI (recommended)

```bash
npm start
# Open http://localhost:3000
```

Enter a URL, click **Scan Now**, view the score and download the PDF report.

## CLI

```bash
# Scan a URL (saves report.pdf in current dir)
node scanner.js --url https://example.com

# Custom output path
node scanner.js --url https://example.com --output my-report.pdf

# Increase timeout for slow pages (ms)
node scanner.js --url https://example.com --timeout 60000
```

## Report Contents

| Section | Details |
|---------|---------|
| Score | 0–100 compliance score |
| Verdict | Low / Medium / High Risk |
| Violations | Grouped by Critical → Serious → Moderate → Minor |
| Per violation | Rule ID, WCAG criterion, description, affected elements, fix link |
| Footer | Scan date + scanned URL on every page |

## Score Calculation

| Weight | Severity |
|--------|----------|
| −25 per node | Critical |
| −15 per node | Serious |
| −8 per node | Moderate |
| −3 per node | Minor |

Score floored at 0. 80+ = Low Risk, 50–79 = Medium Risk, <50 = High Risk.

## Requirements

- Node.js 18+
- Internet connection (for page fetch + Playwright Chromium download)
