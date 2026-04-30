require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { runScan, buildPDF, groupBySeverity } = require('./lib/core');
const { generateFixGuide }                   = require('./lib/ai');

const app        = express();
const REPORTS    = path.join(__dirname, 'reports');
const REPORT_TTL = 60 * 60 * 1000; // 1 hour

const VALID_MAX_PAGES = new Set([1, 5, 10, 25]);

if (!fs.existsSync(REPORTS)) fs.mkdirSync(REPORTS);

app.use(express.json());
app.use(express.static(__dirname, { index: 'index.html' }));

// ─── /scan ───────────────────────────────────────────────────────────────────

app.post('/scan', async (req, res) => {
  const { url, maxPages: rawPages } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required.' });
  }

  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Please enter a valid URL (e.g. https://example.com)' });
  }

  const maxPages = VALID_MAX_PAGES.has(Number(rawPages)) ? Number(rawPages) : 1;

  // Clean up stale reports
  try {
    const cutoff = Date.now() - REPORT_TTL;
    for (const f of fs.readdirSync(REPORTS)) {
      const fp = path.join(REPORTS, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch { /* non-fatal */ }

  try {
    console.log(`\n  Scanning: ${url} (up to ${maxPages} page${maxPages > 1 ? 's' : ''})`);
    const { violations, score, verdict, pageResults } = await runScan(url, 30000, maxPages);
    const groups = groupBySeverity(violations);

    console.log(`  Score: ${score}/100 · ${violations.length} violation(s) · ${pageResults ? pageResults.length : 1} page(s)`);

    const aiRecs   = await generateFixGuide(violations);
    const scanDate = new Date().toUTCString();
    const reportId = crypto.randomBytes(12).toString('hex');

    await buildPDF(
      path.join(REPORTS, `${reportId}.pdf`),
      url, violations, score, verdict, scanDate, aiRecs, pageResults
    );

    res.json({
      score,
      verdict: verdict.label,
      counts: {
        critical: groups.critical.length,
        serious:  groups.serious.length,
        moderate: groups.moderate.length,
        minor:    groups.minor.length,
        total:    violations.length,
      },
      pagesScanned: pageResults ? pageResults.length : 1,
      reportId,
      aiGuideIncluded: !!(aiRecs && aiRecs.size > 0),
    });
  } catch (err) {
    console.error('Scan error:', err.message);
    const msg = err.message || '';
    if (msg.includes('net::ERR') || msg.includes('ERR_NAME') || msg.includes('ERR_CONNECTION'))
      return res.status(422).json({ error: 'Could not reach that website. Check the URL and try again.' });
    if (msg.toLowerCase().includes('timeout'))
      return res.status(408).json({ error: 'The page took too long to load. Try again or use a different URL.' });
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
});

// ─── /download/:id ───────────────────────────────────────────────────────────

app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{24}$/.test(id))
    return res.status(400).send('Invalid report ID.');

  const fp = path.join(REPORTS, `${id}.pdf`);
  if (!fs.existsSync(fp))
    return res.status(404).send('Report not found or expired (reports are kept for 1 hour).');

  res.download(fp, 'accessibility-report.pdf');
});

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const aiEnabled = !!process.env.ANTHROPIC_API_KEY;
  console.log(`\n  Auditly  →  http://localhost:${PORT}`);
  console.log(`  AI Fix Guide  →  ${aiEnabled ? 'enabled (' + (process.env.AI_MODEL || 'claude-sonnet-4-5') + ')' : 'disabled (add ANTHROPIC_API_KEY to .env)'}\n`);
});
