const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';

// Cached across all messages.create() calls in a session (cache TTL: 5 min)
const SYSTEM_PROMPT = `You are a web accessibility expert. Given a WCAG violation, respond with a single JSON object — no markdown, no explanation outside the JSON.

Required fields:
{
  "businessImpact": "<Two plain-English sentences for a non-technical business owner. Explain customer impact and legal/business risk. Zero jargon.>",
  "brokenHtml": "<The exact broken HTML from the violation — copy verbatim>",
  "fixedHtml": "<The corrected HTML with the accessibility issue resolved>",
  "priority": "<Exactly one of: Fix this week | Fix this month | Fix when possible>",
  "priorityReason": "<One sentence explaining the priority>"
}

Priority rules:
- critical → "Fix this week"
- serious  → "Fix this month"
- moderate / minor → "Fix when possible"`;

function buildUserPrompt(violation) {
  const wcagCriteria = violation.tags
    .filter(t => t.startsWith('wcag'))
    .map(t =>
      t.replace('wcag', 'WCAG ')
       .replace(/(\d)(\d)(\d)$/, '$1.$2.$3')
       .replace(/(\d)(\d)$/, '$1.$2')
    )
    .join(', ') || 'WCAG 2.1 AA';

  const sampleHtml = violation.nodes[0]?.html?.trim() || '(no HTML sample)';

  return `Violation:
Rule ID : ${violation.id}
Severity: ${violation.impact}
WCAG    : ${wcagCriteria}
Desc    : ${violation.description}
Help    : ${violation.help || 'N/A'}

Broken HTML:
${sampleHtml}

Return JSON only.`;
}

async function getFixForViolation(client, violation) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }, // Reuse cached system prompt across all violation calls
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(violation) }],
  });

  const raw = (resp.content[0]?.text || '').trim();
  const m   = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object in response');
  return JSON.parse(m[0]);
}

async function generateFixGuide(violations) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n  No ANTHROPIC_API_KEY in .env — AI Fix Guide skipped.\n');
    return null;
  }
  if (!violations || violations.length === 0) return new Map();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // One call per unique rule ID — deduplicates all instances of the same violation
  const unique = new Map();
  for (const v of violations) {
    if (!unique.has(v.id)) unique.set(v.id, v);
  }

  console.log(`\n  AI: Generating fix guide for ${unique.size} rule(s) via ${MODEL}…`);

  const recs = new Map();

  for (const [ruleId, violation] of unique) {
    try {
      const rec = await getFixForViolation(client, violation);
      recs.set(ruleId, { ...rec, severity: violation.impact });
      process.stdout.write('  ✓ ' + ruleId + '\n');
    } catch (err) {
      console.warn(`  ✗ AI skipped for "${ruleId}": ${err.message}`);
      recs.set(ruleId, {
        error: `AI recommendation unavailable: ${err.message}`,
        severity: violation.impact,
      });
    }
  }

  return recs;
}

module.exports = { generateFixGuide };
