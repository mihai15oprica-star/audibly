const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');
const PDFDocument = require('pdfkit');
const fs = require('fs');

// ─── SCORING ─────────────────────────────────────────────────────────────────

function calculateScore(violations) {
  if (violations.length === 0) return 100;
  const weights = { critical: 25, serious: 15, moderate: 8, minor: 3 };
  const penalty = violations.reduce((sum, v) => {
    return sum + (weights[v.impact] || 3) * v.nodes.length;
  }, 0);
  return Math.max(0, Math.round(100 - penalty));
}

function getVerdict(score) {
  if (score >= 80) return { label: 'Low Risk',    color: [39, 174, 96]  };
  if (score >= 50) return { label: 'Medium Risk', color: [230, 126, 34] };
  return               { label: 'High Risk',   color: [192, 57, 43]  };
}

function groupBySeverity(violations) {
  const groups = { critical: [], serious: [], moderate: [], minor: [] };
  for (const v of violations) {
    const key = v.impact || 'minor';
    if (groups[key]) groups[key].push(v);
    else groups.minor.push(v);
  }
  return groups;
}

function wcagRef(tags) {
  return tags
    .filter(t => t.startsWith('wcag'))
    .map(t =>
      t.replace('wcag', 'WCAG ')
       .replace(/(\d)(\d)(\d)$/, '$1.$2.$3')
       .replace(/(\d)(\d)$/, '$1.$2')
    )
    .join(', ') || 'WCAG 2.1 AA';
}

// ─── PDF COLOURS ─────────────────────────────────────────────────────────────

const COLORS = {
  primary:    [26, 86, 219],
  dark:       [17, 24, 39],
  muted:      [107, 114, 128],
  border:     [229, 231, 235],
  bg:         [249, 250, 251],
  white:      [255, 255, 255],
  critical:   [220, 38, 38],
  serious:    [234, 88, 12],
  moderate:   [202, 138, 4],
  minor:      [37, 99, 235],
  criticalBg: [254, 242, 242],
  seriousBg:  [255, 247, 237],
  moderateBg: [254, 252, 232],
  minorBg:    [239, 246, 255],
};

const SEVERITY_META = {
  critical: { label: 'Critical', color: COLORS.critical, bg: COLORS.criticalBg },
  serious:  { label: 'Serious',  color: COLORS.serious,  bg: COLORS.seriousBg  },
  moderate: { label: 'Moderate', color: COLORS.moderate, bg: COLORS.moderateBg },
  minor:    { label: 'Minor',    color: COLORS.minor,    bg: COLORS.minorBg    },
};

const PRIORITY_COLORS = {
  'Fix this week':     [127, 29,  29],
  'Fix this month':    [120, 53,  15],
  'Fix when possible': [30,  58, 138],
};

function rgb(arr) { return arr; }

// ─── CRAWL HELPERS ────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const s = u.toString();
    return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
  } catch { return url; }
}

async function crawlLinks(page, baseUrl) {
  const base = new URL(baseUrl);
  let hrefs = [];
  try {
    hrefs = await page.$$eval('a[href]', as => as.map(a => a.href));
  } catch { return []; }

  const seen = new Set([normalizeUrl(baseUrl)]);
  const links = [];
  for (const href of hrefs) {
    try {
      const u = new URL(href);
      if (u.hostname !== base.hostname) continue;
      if (!u.protocol.startsWith('http')) continue;
      const n = normalizeUrl(u.toString());
      if (!seen.has(n)) {
        seen.add(n);
        links.push(n);
      }
    } catch { /* skip malformed */ }
  }
  return links;
}

// ─── AI SECTION PDF HELPERS ──────────────────────────────────────────────────

function wrapCode(html, charsPerLine = 48) {
  if (!html) return ['(no sample)'];
  const clean = html.replace(/\s+/g, ' ').trim();
  if (!clean) return ['(no sample)'];
  const lines = [];
  for (let i = 0; i < clean.length; i += charsPerLine) {
    lines.push(clean.slice(i, i + charsPerLine));
  }
  return lines;
}

function renderCodeBox(doc, x, y, w, h, label, isFixed, lines) {
  const bg     = isFixed ? [240, 253, 244] : [254, 242, 242];
  const border = isFixed ? [134, 239, 172] : [252, 165, 165];
  const hdr    = isFixed ? [187, 247, 208] : [254, 202, 202];
  const txt    = isFixed ? [22, 101, 52]   : [153, 27,  27];

  doc.roundedRect(x, y, w, h, 4).fill(bg);
  doc.rect(x, y, w, 20).fill(hdr);
  doc.roundedRect(x, y, w, 20, 4).fill(hdr);
  doc.roundedRect(x, y, w, h, 4).strokeColor(border).lineWidth(0.75).stroke();
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(txt)
     .text((isFixed ? '✓ ' : '✗ ') + label, x + 8, y + 6);

  let cy = y + 24;
  for (const line of lines.slice(0, 8)) {
    if (cy + 10 > y + h - 4) break;
    doc.font('Courier').fontSize(7).fillColor([55, 65, 81])
       .text(line, x + 6, cy, { width: w - 12, lineBreak: false });
    cy += 10;
  }
}

function renderAISection(doc, W, H, ML, MR, CW, aiRecs, violations) {
  doc.addPage();

  doc.rect(0, 0, W, 86).fill([15, 23, 42]);

  doc.roundedRect(ML, 22, 30, 18, 4).fill([99, 102, 241]);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor([255, 255, 255])
     .text('AI', ML + 9, 27);

  doc.font('Helvetica-Bold').fontSize(19).fillColor([255, 255, 255])
     .text('AI-Powered Fix Guide', ML + 40, 20);
  doc.font('Helvetica').fontSize(9).fillColor([147, 197, 253])
     .text(
       `Claude AI recommendations · ${aiRecs.size} violation type${aiRecs.size !== 1 ? 's' : ''} analyzed`,
       ML + 40, 46
     );

  let y = 104;

  const sevOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const seen = new Set();
  const sorted = [...violations].sort(
    (a, b) => (sevOrder[a.impact] ?? 4) - (sevOrder[b.impact] ?? 4)
  );

  const tx   = ML + 16;
  const tw   = CW - 32;
  const colW = (tw - 16) / 2;
  const CODE_BOX_H = 20 + 6 * 10 + 8;

  for (const violation of sorted) {
    if (seen.has(violation.id)) continue;
    seen.add(violation.id);

    const rec  = aiRecs.get(violation.id);
    if (!rec) continue;

    const meta = SEVERITY_META[violation.impact] || SEVERITY_META.minor;

    const impactText = rec.error ? rec.error : (rec.businessImpact || '');
    const impactTextH = doc.heightOfString(impactText, {
      width: tw - 24,
      fontSize: rec.error ? 8.5 : 9.5,
    });
    const impactBoxH = impactTextH + 24;

    const showCode = !rec.error && (rec.brokenHtml || rec.fixedHtml);
    const reasonH  = (!rec.error && rec.priorityReason)
      ? doc.heightOfString(rec.priorityReason, { width: tw, fontSize: 8 }) + 8
      : 0;

    const cardH =
      14 +
      22 +
      10 +
      13 +
      impactBoxH +
      (showCode ? 10 + 13 + CODE_BOX_H : 0) +
      reasonH +
      14;

    if (y + cardH > H - 40) { doc.addPage(); y = 40; }

    doc.roundedRect(ML, y, CW, cardH, 6)
       .strokeColor(rgb(COLORS.border)).lineWidth(1).stroke();
    doc.roundedRect(ML, y, CW, cardH, 6).fill(rgb(COLORS.white));
    doc.roundedRect(ML, y, 4, cardH, 2).fill(rgb(meta.color));

    let cy = y + 14;

    doc.roundedRect(tx, cy, 70, 16, 8).fill(rgb(meta.bg));
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(rgb(meta.color))
       .text(violation.id, tx, cy + 4, { width: 70, align: 'center' });

    const wcagStr = wcagRef(violation.tags || []);
    const wcagPad = doc.widthOfString(wcagStr, { size: 7.5 }) + 12;
    doc.roundedRect(tx + 76, cy, wcagPad, 16, 8).fill(rgb(COLORS.bg));
    doc.font('Helvetica').fontSize(7.5).fillColor(rgb(COLORS.muted))
       .text(wcagStr, tx + 82, cy + 4);

    if (rec.priority && !rec.error) {
      const pColor = PRIORITY_COLORS[rec.priority] || PRIORITY_COLORS['Fix when possible'];
      const pW     = doc.widthOfString(rec.priority, { size: 7.5 }) + 18;
      const pX     = ML + CW - MR / 2 - pW;
      doc.roundedRect(pX, cy, pW, 16, 8).fill(pColor);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor([255, 255, 255])
         .text(rec.priority, pX, cy + 4, { width: pW, align: 'center' });
    }

    cy += 22 + 10;

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(rgb(COLORS.dark))
       .text('Why this matters for your business', tx, cy);
    cy += 13;

    const boxBg = rec.error ? [254, 242, 242] : [239, 246, 255];
    doc.roundedRect(tx, cy, tw, impactBoxH, 4).fill(boxBg);

    const textColor = rec.error ? [153, 27, 27] : rgb(COLORS.dark);
    const textSize  = rec.error ? 8.5 : 9.5;
    doc.font('Helvetica').fontSize(textSize).fillColor(textColor)
       .text(impactText, tx + 12, cy + 12, { width: tw - 24 });
    cy += impactBoxH;

    if (showCode) {
      cy += 10;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(rgb(COLORS.dark))
         .text('Code Fix', tx, cy);
      cy += 13;

      const brokenLines = wrapCode(rec.brokenHtml, 46);
      const fixedLines  = wrapCode(rec.fixedHtml,  46);

      renderCodeBox(doc, tx,          cy, colW, CODE_BOX_H, 'Before', false, brokenLines);
      doc.font('Helvetica').fontSize(14).fillColor(rgb(COLORS.muted))
         .text('→', tx + colW + 1, cy + CODE_BOX_H / 2 - 8, { width: 14, align: 'center' });
      renderCodeBox(doc, tx + colW + 16, cy, colW, CODE_BOX_H, 'After', true, fixedLines);

      cy += CODE_BOX_H;
    }

    if (!rec.error && rec.priorityReason) {
      cy += 6;
      doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
         .text(rec.priorityReason, tx, cy, { width: tw });
    }

    y += cardH + 12;
  }
}

// ─── PDF VIOLATION BODY (shared renderer) ────────────────────────────────────

function renderViolationsBody(doc, y, violations, score, verdict, W, H, ML, MR, CW) {
  const groups = groupBySeverity(violations);

  // Score bar
  doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.dark))
     .text('Compliance Score', ML, y);
  y += 16;
  doc.roundedRect(ML, y, CW, 10, 5).fill(rgb(COLORS.border));
  const fillW = Math.round((score / 100) * CW);
  if (fillW > 0) doc.roundedRect(ML, y, fillW, 10, 5).fill(rgb(verdict.color));
  doc.font('Helvetica').fontSize(9).fillColor(rgb(COLORS.muted))
     .text(`${score}/100`, W - MR - 35, y - 1);
  y += 26;

  for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
    const items = groups[sev];
    if (items.length === 0) continue;
    const meta = SEVERITY_META[sev];

    if (y > H - 160) { doc.addPage(); y = 50; }

    doc.roundedRect(ML, y, CW, 28, 4).fill(rgb(meta.bg));
    doc.roundedRect(ML, y, 4, 28, 2).fill(rgb(meta.color));
    doc.font('Helvetica-Bold').fontSize(11).fillColor(rgb(meta.color))
       .text(`${meta.label} (${items.length})`, ML + 14, y + 8);
    y += 38;

    for (const v of items) {
      const descLines = Math.ceil(v.description.length / 90) + 1;
      const helpLines = Math.ceil((v.help || '').length / 90) + 1;
      const fixLines  = v.helpUrl ? 1 : 0;
      const nodeCount = Math.min(v.nodes.length, 3);
      const cardH = 28 + (descLines + helpLines + fixLines) * 14 + nodeCount * 18 + 20;

      if (y + cardH > H - 80) { doc.addPage(); y = 50; }

      doc.roundedRect(ML, y, CW, cardH, 5)
         .strokeColor(rgb(COLORS.border)).lineWidth(1).stroke();
      doc.roundedRect(ML, y, CW, cardH, 5).fill(rgb(COLORS.white));
      doc.roundedRect(ML, y, 3, cardH, 1).fill(rgb(meta.color));

      let cy = y + 10;
      const tx = ML + 14;
      const tw = CW - 28;

      doc.roundedRect(tx, cy, 70, 16, 8).fill(rgb(meta.bg));
      doc.font('Helvetica-Bold').fontSize(8).fillColor(rgb(meta.color))
         .text(v.id, tx, cy + 4, { width: 70, align: 'center' });

      const wcagStr = wcagRef(v.tags || []);
      doc.roundedRect(tx + 76, cy, doc.widthOfString(wcagStr, { size: 8 }) + 10, 16, 8)
         .fill(rgb(COLORS.bg));
      doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
         .text(wcagStr, tx + 81, cy + 4);

      cy += 22;

      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(rgb(COLORS.dark))
         .text(v.description, tx, cy, { width: tw });
      cy += doc.heightOfString(v.description, { width: tw, fontSize: 9.5 }) + 4;

      if (v.help) {
        doc.font('Helvetica').fontSize(9).fillColor(rgb(COLORS.muted))
           .text(v.help, tx, cy, { width: tw });
        cy += doc.heightOfString(v.help, { width: tw, fontSize: 9 }) + 4;
      }

      if (v.helpUrl) {
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(rgb(COLORS.dark))
           .text('How to fix: ', tx, cy, { continued: true, width: tw });
        doc.font('Helvetica').fontSize(8.5).fillColor(rgb(COLORS.primary))
           .text(v.helpUrl, { width: tw });
        cy += 16;
      }

      if (v.nodes.length > 0) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(rgb(COLORS.muted))
           .text(`Affected elements (${v.nodes.length}):`, tx, cy);
        cy += 13;

        for (const node of v.nodes.slice(0, 3)) {
          const sel = node.target?.[0] || node.html?.slice(0, 80) || '(unknown)';
          doc.roundedRect(tx, cy, tw, 15, 3).fill(rgb(COLORS.bg));
          doc.font('Courier').fontSize(7.5).fillColor(rgb(COLORS.dark))
             .text(sel, tx + 4, cy + 4, { width: tw - 8, ellipsis: true });
          cy += 18;
        }
        if (v.nodes.length > 3) {
          doc.font('Helvetica').fontSize(7.5).fillColor(rgb(COLORS.muted))
             .text(`  …and ${v.nodes.length - 3} more`, tx, cy);
          cy += 12;
        }
      }

      y = cy + 14;
    }
  }

  if (violations.length === 0) {
    if (y > H - 120) { doc.addPage(); y = 50; }
    doc.roundedRect(ML, y, CW, 60, 6).fill([236, 253, 245]);
    doc.font('Helvetica-Bold').fontSize(14).fillColor([22, 163, 74])
       .text('No violations found', ML, y + 20, { width: CW, align: 'center' });
    doc.font('Helvetica').fontSize(10).fillColor([74, 222, 128])
       .text('This page meets WCAG 2.1 AA requirements.', ML, y + 38, { width: CW, align: 'center' });
    y += 80;
  }

  return y;
}

// ─── PDF BUILD ────────────────────────────────────────────────────────────────

function buildPDF(outputPath, url, violations, score, verdict, scanDate, aiRecs = null, pageResults = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title:    'Auditly Accessibility Report',
        Author:   'Auditly',
        Subject:  `Accessibility audit for ${url}`,
        Keywords: 'WCAG, accessibility, a11y, compliance',
        Creator:  'auditly v1.0.0',
      },
      bufferPages: true,
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const W  = doc.page.width;
    const H  = doc.page.height;
    const ML = 50;
    const MR = 50;
    const CW = W - ML - MR;

    if (pageResults && pageResults.length > 0) {
      // ── MULTI-PAGE: SUMMARY COVER PAGE ─────────────────────────────────────
      doc.rect(0, 0, W, 120).fill(rgb(COLORS.primary));

      doc.roundedRect(ML, 31, 28, 28, 5).fill([79, 70, 229]);
      doc.fontSize(11).fillColor([255, 255, 255])
         .font('Helvetica-Bold').text('AU', ML, 38, { width: 28, align: 'center' });

      doc.fillColor(rgb(COLORS.white)).font('Helvetica-Bold').fontSize(20)
         .text('Auditly Accessibility Report', ML + 38, 32);
      doc.font('Helvetica').fontSize(10).fillColor([180, 210, 255])
         .text(url, ML + 38, 58, { width: CW - 38, ellipsis: true });

      const scoreX = W - MR - 90;
      doc.roundedRect(scoreX, 25, 90, 70, 8).fill([255, 255, 255, 0.15]);
      doc.font('Helvetica-Bold').fontSize(36).fillColor(rgb(COLORS.white))
         .text(`${score}`, scoreX, 32, { width: 90, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor([180, 210, 255])
         .text('AVG / 100', scoreX, 70, { width: 90, align: 'center' });

      let y = 140;
      const allGroups = groupBySeverity(violations);

      // Summary badges
      doc.roundedRect(ML, y, CW, 60, 6).fill(rgb(COLORS.bg));
      doc.roundedRect(ML, y, 4, 60, 2).fill(rgb(verdict.color));
      doc.font('Helvetica-Bold').fontSize(11).fillColor(rgb(COLORS.dark))
         .text('Overall Risk', ML + 18, y + 10);
      doc.roundedRect(ML + 18, y + 26, 90, 22, 11).fill(rgb(verdict.color));
      doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.white))
         .text(verdict.label, ML + 18, y + 31, { width: 90, align: 'center' });

      // Pages scanned badge
      doc.roundedRect(ML + 122, y + 10, 80, 38, 5).fill(rgb(COLORS.bg));
      doc.font('Helvetica-Bold').fontSize(22).fillColor(rgb(COLORS.dark))
         .text(`${pageResults.length}`, ML + 122, y + 12, { width: 80, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
         .text('pages scanned', ML + 122, y + 37, { width: 80, align: 'center' });

      // Severity count badges
      const badgeW = 56;
      let bx = ML + 216;
      for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
        const meta = SEVERITY_META[sev];
        doc.roundedRect(bx, y + 10, badgeW, 38, 5).fill(rgb(meta.bg));
        doc.font('Helvetica-Bold').fontSize(18).fillColor(rgb(meta.color))
           .text(`${allGroups[sev].length}`, bx, y + 12, { width: badgeW, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
           .text(meta.label, bx, y + 37, { width: badgeW, align: 'center' });
        bx += badgeW + 6;
      }
      y += 80;

      // AI indicator
      if (aiRecs && aiRecs.size > 0) {
        doc.roundedRect(ML, y, CW, 26, 4).fill([238, 242, 255]);
        doc.roundedRect(ML, y, 4, 26, 2).fill([99, 102, 241]);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor([67, 56, 202])
           .text(
             `✨  AI Fix Guide included — see final section of this report (${aiRecs.size} rule${aiRecs.size !== 1 ? 's' : ''} analyzed)`,
             ML + 14, y + 8
           );
        y += 36;
      }

      // Overall score bar
      doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.dark))
         .text('Overall Compliance Score (average)', ML, y);
      y += 16;
      doc.roundedRect(ML, y, CW, 10, 5).fill(rgb(COLORS.border));
      const totalFillW = Math.round((score / 100) * CW);
      if (totalFillW > 0) doc.roundedRect(ML, y, totalFillW, 10, 5).fill(rgb(verdict.color));
      doc.font('Helvetica').fontSize(9).fillColor(rgb(COLORS.muted))
         .text(`${score}/100`, W - MR - 35, y - 1);
      y += 30;

      // Best / Worst callout cards
      const scored = pageResults.filter(r => !r.error).sort((a, b) => a.score - b.score);
      if (scored.length >= 2) {
        const worst = scored[0];
        const best  = scored[scored.length - 1];
        const hw    = (CW - 12) / 2;

        doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.dark))
           .text('Page Highlights', ML, y);
        y += 16;

        doc.roundedRect(ML, y, hw, 52, 4).fill([254, 242, 242]);
        doc.roundedRect(ML, y, 4, 52, 2).fill(rgb(COLORS.critical));
        doc.font('Helvetica-Bold').fontSize(8).fillColor(rgb(COLORS.critical))
           .text('Needs Most Work', ML + 12, y + 8);
        doc.font('Helvetica').fontSize(7.5).fillColor(rgb(COLORS.dark))
           .text(worst.url, ML + 12, y + 22, { width: hw - 20, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(14).fillColor(rgb(COLORS.critical))
           .text(`${worst.score}/100`, ML + 12, y + 32);

        const bx2 = ML + hw + 12;
        doc.roundedRect(bx2, y, hw, 52, 4).fill([236, 253, 245]);
        doc.roundedRect(bx2, y, 4, 52, 2).fill([22, 163, 74]);
        doc.font('Helvetica-Bold').fontSize(8).fillColor([22, 163, 74])
           .text('Best Performing', bx2 + 12, y + 8);
        doc.font('Helvetica').fontSize(7.5).fillColor(rgb(COLORS.dark))
           .text(best.url, bx2 + 12, y + 22, { width: hw - 20, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(14).fillColor([22, 163, 74])
           .text(`${best.score}/100`, bx2 + 12, y + 32);

        y += 64;
      }

      // Pages list table
      doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.dark))
         .text('All Pages Scanned', ML, y);
      y += 14;

      for (const pr of pageResults) {
        if (y > H - 50) { doc.addPage(); y = 50; }
        const sc = pr.error ? null : pr.score;
        const vc = sc !== null ? rgb(getVerdict(sc).color) : rgb(COLORS.muted);

        doc.roundedRect(ML, y, CW, 24, 3).fill(rgb(COLORS.bg));
        doc.font('Helvetica').fontSize(8.5).fillColor(rgb(COLORS.dark))
           .text(pr.url, ML + 8, y + 7, { width: CW - 110, ellipsis: true });

        if (sc !== null) {
          const barW = 54;
          const barX = W - MR - 54 - 52;
          doc.roundedRect(barX, y + 9, barW, 6, 3).fill(rgb(COLORS.border));
          const fw = Math.round((sc / 100) * barW);
          if (fw > 0) doc.roundedRect(barX, y + 9, fw, 6, 3).fill(vc);
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(vc)
             .text(`${sc}/100`, W - MR - 50, y + 7, { width: 50, align: 'right' });
        } else {
          doc.font('Helvetica').fontSize(8.5).fillColor(rgb(COLORS.muted))
             .text('error', W - MR - 50, y + 7, { width: 50, align: 'right' });
        }
        y += 28;
      }

      // ── MULTI-PAGE: PER-PAGE SECTIONS ──────────────────────────────────────
      for (let i = 0; i < pageResults.length; i++) {
        const pr = pageResults[i];
        doc.addPage();

        // Page section header
        doc.rect(0, 0, W, 70).fill(rgb(COLORS.dark));
        doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
           .text(`Page ${i + 1} of ${pageResults.length}`, ML, 18);
        doc.font('Helvetica-Bold').fontSize(13).fillColor(rgb(COLORS.white))
           .text(pr.url, ML, 32, { width: CW - 100, ellipsis: true });

        const pv = pr.error ? getVerdict(0) : pr.verdict;
        const ps = pr.error ? 0 : pr.score;
        doc.roundedRect(W - MR - 84, 14, 84, 42, 6).fill([255, 255, 255, 0.1]);
        doc.font('Helvetica-Bold').fontSize(24).fillColor(rgb(COLORS.white))
           .text(pr.error ? 'ERR' : `${ps}`, W - MR - 84, 18, { width: 84, align: 'center' });
        doc.font('Helvetica').fontSize(7.5).fillColor(rgb(COLORS.muted))
           .text(pr.error ? 'failed to load' : pv.label, W - MR - 84, 44, { width: 84, align: 'center' });

        if (pr.error) {
          doc.font('Helvetica').fontSize(9).fillColor(rgb(COLORS.muted))
             .text(`Could not scan this page: ${pr.error}`, ML, 90, { width: CW });
        } else {
          renderViolationsBody(doc, 90, pr.violations, ps, pv, W, H, ML, MR, CW);
        }
      }

    } else {
      // ── SINGLE PAGE: original layout ───────────────────────────────────────
      doc.rect(0, 0, W, 120).fill(rgb(COLORS.primary));

      doc.roundedRect(ML, 31, 28, 28, 5).fill([79, 70, 229]);
      doc.fontSize(11).fillColor([255, 255, 255])
         .font('Helvetica-Bold').text('AU', ML, 38, { width: 28, align: 'center' });

      doc.fillColor(rgb(COLORS.white)).font('Helvetica-Bold').fontSize(20)
         .text('Auditly Accessibility Report', ML + 38, 32);
      doc.font('Helvetica').fontSize(10).fillColor([180, 210, 255])
         .text(url, ML + 38, 58, { width: CW - 38, ellipsis: true });

      const scoreX = W - MR - 90;
      doc.roundedRect(scoreX, 25, 90, 70, 8).fill([255, 255, 255, 0.15]);
      doc.font('Helvetica-Bold').fontSize(36).fillColor(rgb(COLORS.white))
         .text(`${score}`, scoreX, 32, { width: 90, align: 'center' });
      doc.font('Helvetica').fontSize(9).fillColor([180, 210, 255])
         .text('SCORE / 100', scoreX, 70, { width: 90, align: 'center' });

      let y = 140;
      const groups = groupBySeverity(violations);

      doc.roundedRect(ML, y, CW, 60, 6).fill(rgb(COLORS.bg));
      doc.roundedRect(ML, y, 4, 60, 2).fill(rgb(verdict.color));
      doc.font('Helvetica-Bold').fontSize(11).fillColor(rgb(COLORS.dark))
         .text('Risk Verdict', ML + 18, y + 10);
      doc.roundedRect(ML + 18, y + 26, 90, 22, 11).fill(rgb(verdict.color));
      doc.font('Helvetica-Bold').fontSize(10).fillColor(rgb(COLORS.white))
         .text(verdict.label, ML + 18, y + 31, { width: 90, align: 'center' });

      const badges = ['critical', 'serious', 'moderate', 'minor'];
      const badgeW = 68;
      let bx = ML + 130;
      for (const sev of badges) {
        const meta = SEVERITY_META[sev];
        doc.roundedRect(bx, y + 10, badgeW, 38, 5).fill(rgb(meta.bg));
        doc.font('Helvetica-Bold').fontSize(18).fillColor(rgb(meta.color))
           .text(`${groups[sev].length}`, bx, y + 12, { width: badgeW, align: 'center' });
        doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
           .text(meta.label, bx, y + 36, { width: badgeW, align: 'center' });
        bx += badgeW + 8;
      }
      y += 80;

      if (aiRecs && aiRecs.size > 0) {
        doc.roundedRect(ML, y, CW, 26, 4).fill([238, 242, 255]);
        doc.roundedRect(ML, y, 4, 26, 2).fill([99, 102, 241]);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor([67, 56, 202])
           .text(
             `✨  AI Fix Guide included — see final section of this report (${aiRecs.size} rule${aiRecs.size !== 1 ? 's' : ''} analyzed)`,
             ML + 14, y + 8
           );
        y += 36;
      }

      renderViolationsBody(doc, y, violations, score, verdict, W, H, ML, MR, CW);
    }

    // ── AI FIX GUIDE (both modes) ─────────────────────────────────────────────
    if (aiRecs && aiRecs.size > 0) {
      renderAISection(doc, W, H, ML, MR, CW, aiRecs, violations);
    }

    // ── FOOTER ON EVERY PAGE ──────────────────────────────────────────────────
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.rect(0, H - 36, W, 36).fill(rgb(COLORS.dark));
      doc.font('Helvetica-Bold').fontSize(8).fillColor([130, 120, 240])
         .text('auditly.io', ML, H - 24, { width: 60 });
      doc.font('Helvetica').fontSize(8).fillColor(rgb(COLORS.muted))
         .text(`Scanned: ${url}`, ML + 68, H - 24, { width: CW / 2 - 68, ellipsis: true })
         .text(`Page ${i + 1} of ${totalPages}`, ML + CW / 2, H - 24, {
           width: CW / 2, align: 'right',
         });
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────

async function runScan(url, timeout = 30000, maxPages = 1) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();

    // ── Single page (original behavior) ──────────────────────────────────────
    if (maxPages === 1) {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'load', timeout });
      await page.waitForLoadState('domcontentloaded', { timeout });
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const violations = results.violations;
      const score      = calculateScore(violations);
      const verdict    = getVerdict(score);
      return { violations, score, verdict, pageResults: null };
    }

    // ── Multi-page crawl ──────────────────────────────────────────────────────
    const pageResults = [];
    const queue       = [url];
    const scannedUrls = new Set([normalizeUrl(url)]);

    while (queue.length > 0 && pageResults.length < maxPages) {
      const currentUrl = queue.shift();
      const page = await context.newPage();
      let pr;

      try {
        await page.goto(currentUrl, { waitUntil: 'load', timeout });
        await page.waitForLoadState('domcontentloaded', { timeout });

        // Collect internal links from first page only
        if (pageResults.length === 0) {
          const links = await crawlLinks(page, url);
          for (const link of links.slice(0, maxPages - 1)) {
            if (!scannedUrls.has(normalizeUrl(link))) {
              scannedUrls.add(normalizeUrl(link));
              queue.push(link);
            }
          }
        }

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        const violations = results.violations;
        const score      = calculateScore(violations);
        const verdict    = getVerdict(score);
        pr = { url: currentUrl, violations, score, verdict };
      } catch (err) {
        pr = { url: currentUrl, violations: [], score: 100, verdict: getVerdict(100), error: err.message };
      } finally {
        await page.close();
      }

      pageResults.push(pr);
    }

    const allViolations  = pageResults.flatMap(r => r.violations);
    const scoredPages    = pageResults.filter(r => !r.error);
    const overallScore   = scoredPages.length > 0
      ? Math.round(scoredPages.reduce((s, r) => s + r.score, 0) / scoredPages.length)
      : 0;
    const overallVerdict = getVerdict(overallScore);

    return { violations: allViolations, score: overallScore, verdict: overallVerdict, pageResults };
  } finally {
    await browser.close();
  }
}

module.exports = { calculateScore, getVerdict, groupBySeverity, wcagRef, buildPDF, runScan };
