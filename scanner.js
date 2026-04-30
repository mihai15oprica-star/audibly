#!/usr/bin/env node

require('dotenv').config();

const { Command }    = require('commander');
const path           = require('path');
const { runScan, buildPDF, groupBySeverity } = require('./lib/core');
const { generateFixGuide }                   = require('./lib/ai');

const program = new Command();
program
  .name('auditly')
  .description('Auditly — WCAG 2.1 AA accessibility scanner with PDF report')
  .version('1.0.0')
  .requiredOption('-u, --url <url>', 'URL to scan')
  .option('-o, --output <file>', 'output PDF path', 'report.pdf')
  .option('--timeout <ms>', 'page load timeout in ms', '30000')
  .option('--pages <n>', 'max pages to scan (1, 5, 10, 25)', '1')
  .option('--no-ai', 'skip AI-powered fix recommendations')
  .parse(process.argv);

const opts = program.opts();

(async () => {
  const url      = opts.url;
  const output   = path.resolve(opts.output);
  const timeout  = parseInt(opts.timeout, 10);
  const maxPages = [1, 5, 10, 25].includes(parseInt(opts.pages, 10))
    ? parseInt(opts.pages, 10) : 1;

  console.log(`\n  WCAG 2.1 AA Scanner`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  URL     : ${url}`);
  console.log(`  Output  : ${output}`);
  console.log(`  Pages   : up to ${maxPages}`);
  console.log('');

  try {
    console.log('  [1/4] Launching browser & loading page…');
    const { violations, score, verdict, pageResults } = await runScan(url, timeout, maxPages);

    console.log('  [2/4] Scan complete.');
    console.log(`\n  Score  : ${score}/100`);
    console.log(`  Verdict: ${verdict.label}`);
    console.log(`  Pages  : ${pageResults ? pageResults.length : 1} scanned`);
    console.log(`  Issues : ${violations.length} violation(s)\n`);

    const groups = groupBySeverity(violations);
    for (const [sev, items] of Object.entries(groups)) {
      if (items.length > 0) console.log(`    ${sev.padEnd(10)}: ${items.length}`);
    }

    console.log('\n  [3/4] Generating AI fix recommendations…');
    const aiRecs = opts.ai ? await generateFixGuide(violations) : null;

    console.log('\n  [4/4] Building PDF report…');
    await buildPDF(output, url, violations, score, verdict, new Date().toUTCString(), aiRecs, pageResults);

    console.log(`\n  Report saved → ${output}\n`);
  } catch (err) {
    console.error(`\n  ERROR: ${err.message}\n`);
    process.exit(1);
  }
})();
