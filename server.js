require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { runScan, buildPDF, groupBySeverity } = require('./lib/core');
const { generateFixGuide }                   = require('./lib/ai');

const app        = express();
const REPORTS    = path.join(__dirname, 'reports');
const REPORT_TTL = 60 * 60 * 1000;
const TOKEN_TTL  = 15 * 60 * 1000;

const VALID_MAX_PAGES = new Set([1, 5, 10, 25]);

if (!fs.existsSync(REPORTS)) fs.mkdirSync(REPORTS);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname, { index: 'index.html' }));

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) header.split(';').forEach(part => {
    const [k, ...rest] = part.split('=');
    cookies[k.trim()] = decodeURIComponent(rest.join('=').trim());
  });
  return cookies;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Admin sessions (in-memory) ────────────────────────────────────────────────

const adminSessions = new Set();

function isAdminAuthed(req) {
  const { auditly_admin: sid } = parseCookies(req);
  return !!sid && adminSessions.has(sid);
}

// ── Scan tokens (15-min TTL) ──────────────────────────────────────────────────

const scanTokens = new Map();

function makeToken(reportId) {
  const token = crypto.randomBytes(16).toString('hex');
  scanTokens.set(token, { reportId, expires: Date.now() + TOKEN_TTL });
  return token;
}

function useToken(token) {
  const entry = scanTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expires) { scanTokens.delete(token); return null; }
  return entry;
}

function pruneTokens() {
  const now = Date.now();
  for (const [k, v] of scanTokens) if (now > v.expires) scanTokens.delete(k);
}

// ── Page templates ────────────────────────────────────────────────────────────

const SHIELD_SVG = `<svg aria-hidden="true" focusable="false" width="22" height="26" viewBox="0 0 28 32" fill="none">
          <defs>
            <linearGradient id="shield-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#F5A623"/>
              <stop offset="1" stop-color="#F76B1C"/>
            </linearGradient>
          </defs>
          <path d="M14 1L2 6v9c0 8.284 5.143 15.408 12 17.92C20.857 30.408 26 23.284 26 15V6L14 1z" fill="url(#shield-grad)"/>
          <polyline points="8,16 12,20 20,12" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        </svg>`;

function adminLoginPage(showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Login — Auditly</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(170deg, #020817 0%, #050D2B 55%, #030615 100%);
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      color: #fff;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 20px; padding: 40px;
      width: 100%; max-width: 400px;
      box-shadow: 0 24px 64px rgba(0,0,0,.4);
    }
    .brand {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 28px; justify-content: center;
      text-decoration: none; color: #fff;
    }
    .brand-name { font-size: 1.25rem; font-weight: 700; }
    h1 { font-size: 1.375rem; font-weight: 800; margin-bottom: 6px; letter-spacing: -.02em; text-align: center; }
    .subtitle { font-size: .875rem; color: rgba(255,255,255,.65); margin-bottom: 28px; text-align: center; }
    .error-box {
      background: rgba(239,68,68,.15); border: 1px solid rgba(239,68,68,.35);
      border-radius: 10px; padding: 12px 16px; font-size: .875rem;
      color: #FCA5A5; margin-bottom: 20px;
    }
    label {
      display: block; font-size: .8125rem; font-weight: 600;
      color: rgba(255,255,255,.75); letter-spacing: .04em;
      text-transform: uppercase; margin-bottom: 8px;
    }
    input[type="password"] {
      width: 100%; padding: 13px 16px;
      background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18);
      border-radius: 10px; color: #fff; font-size: 1rem; outline: none;
      font-family: inherit; transition: border-color .2s, box-shadow .2s;
    }
    input[type="password"]:focus {
      border-color: rgba(59,130,246,.6);
      box-shadow: 0 0 0 3px rgba(59,130,246,.12);
    }
    button {
      margin-top: 20px; width: 100%; padding: 14px;
      background: linear-gradient(135deg, #2563EB, #7C3AED);
      color: #fff; border: none; border-radius: 10px;
      font-size: .9375rem; font-weight: 700; cursor: pointer;
      font-family: inherit;
      box-shadow: 0 4px 20px rgba(37,99,235,.4); transition: filter .15s;
    }
    button:hover:not(:disabled) { filter: brightness(1.1); }
    button:focus-visible { outline: 3px solid #93C5FD; outline-offset: 3px; }
    .back {
      display: block; text-align: center; margin-top: 18px;
      font-size: .85rem; color: rgba(255,255,255,.65); text-decoration: none;
    }
    .back:hover { color: rgba(255,255,255,.9); }
    .back:focus-visible { outline: 2px solid #93C5FD; border-radius: 2px; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      <a href="/" class="brand" aria-label="Auditly — go to homepage">
        ${SHIELD_SVG}
        <span class="brand-name">Auditly</span>
      </a>
      <h1>Admin Login</h1>
      <p class="subtitle">Internal access only</p>
      <div
        class="error-box"
        role="alert"
        id="password-error"
        ${showError ? '' : 'hidden'}
      >${showError ? 'Incorrect password. Please try again.' : ''}</div>
      <form method="POST" action="/admin/login" novalidate>
        <div>
          <label for="password">Password</label>
          <input
            type="password"
            id="password"
            name="password"
            required
            autocomplete="current-password"
            autofocus
            ${showError ? 'aria-invalid="true"' : ''}
            aria-describedby="password-error"
          >
        </div>
        <button type="submit">Sign In →</button>
      </form>
      <a href="/" class="back">← Back to Auditly</a>
    </div>
  </main>
</body>
</html>`;
}

function adminDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard — Auditly</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700;14..32,800;14..32,900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(170deg, #020817 0%, #050D2B 55%, #030615 100%);
      min-height: 100vh; color: #0F172A;
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; } button, input, select, a { font-family: inherit; }

    /* Skip link */
    .skip-link {
      position: absolute; top: -100%; left: 0;
      background: #2563EB; color: #fff; padding: 12px 24px;
      font-weight: 600; font-size: .9375rem; text-decoration: none; z-index: 9999;
      border-radius: 0 0 8px 0; transition: top .15s;
    }
    .skip-link:focus { top: 0; outline: 3px solid #fff; outline-offset: -3px; }

    /* Admin badge */
    .admin-badge {
      position: fixed; top: 14px; right: 16px; z-index: 300;
      background: linear-gradient(135deg, #DC2626, #B91C1C);
      color: #fff; font-size: .6875rem; font-weight: 800;
      letter-spacing: .08em; text-transform: uppercase;
      padding: 5px 12px; border-radius: 999px;
      box-shadow: 0 2px 10px rgba(220,38,38,.5);
      pointer-events: none; user-select: none;
    }

    /* Header */
    .header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 24px; max-width: 760px; margin: 0 auto;
    }
    .header-brand {
      display: flex; align-items: center; gap: 10px;
      text-decoration: none; color: #fff;
    }
    .header-brand-name { font-size: 1rem; font-weight: 700; }
    .header-title { font-size: .8125rem; font-weight: 600; color: rgba(255,255,255,.60); }
    .btn-logout {
      background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.18);
      color: rgba(255,255,255,.75); padding: 8px 16px; border-radius: 8px;
      font-size: .875rem; font-weight: 600; cursor: pointer;
      transition: background .15s;
    }
    .btn-logout:hover { background: rgba(255,255,255,.15); color: #fff; }
    .btn-logout:focus-visible { outline: 2px solid #93C5FD; outline-offset: 2px; }

    /* Main content */
    .main-wrap {
      max-width: 760px; margin: 0 auto; padding: 0 24px 64px;
    }

    /* Scanner card */
    .scanner-card {
      background: #fff; border-radius: 20px;
      box-shadow: 0 24px 64px rgba(0,0,0,.3); padding: 40px;
      margin-bottom: 28px;
    }
    .card-heading {
      font-size: 1.375rem; font-weight: 800; color: #0F172A;
      margin-bottom: 24px; letter-spacing: -.02em;
    }

    /* Scan form */
    .field-label {
      display: block; font-size: .8125rem; font-weight: 600;
      color: #64748B; letter-spacing: .04em;
      text-transform: uppercase; margin-bottom: 8px;
    }
    .scan-bar {
      display: flex; background: #F8FAFC;
      border: 1.5px solid #E2E8F0; border-radius: 12px; padding: 5px;
      transition: border-color .2s, box-shadow .2s; margin-bottom: 14px;
    }
    .scan-bar:focus-within {
      border-color: rgba(37,99,235,.5);
      box-shadow: 0 0 0 3px rgba(37,99,235,.08);
    }
    .scan-input {
      flex: 1; min-width: 0; background: transparent; border: none; outline: none;
      padding: 12px 14px; font-size: 1rem; color: #0F172A;
    }
    .scan-input::placeholder { color: #94A3B8; }
    .scan-input[aria-invalid="true"] { color: #DC2626; }

    #scan-btn {
      background: linear-gradient(135deg, #2563EB, #7C3AED);
      color: #fff; border: none; border-radius: 8px;
      padding: 12px 22px; font-size: .9375rem; font-weight: 700; cursor: pointer;
      white-space: nowrap; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 3px 14px rgba(37,99,235,.4);
      transition: filter .15s, transform .1s;
    }
    #scan-btn:hover:not(:disabled) { filter: brightness(1.1); }
    #scan-btn:active:not(:disabled) { transform: scale(.98); }
    #scan-btn:focus-visible { outline: 3px solid #93C5FD; outline-offset: 3px; }
    #scan-btn:disabled { opacity: .6; cursor: not-allowed; }

    /* Pages row */
    .pages-row {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 8px;
    }
    .pages-label { font-size: .8125rem; font-weight: 600; color: #64748B; letter-spacing: .04em; text-transform: uppercase; }
    #pages-select {
      background: #F8FAFC; border: 1.5px solid #E2E8F0;
      border-radius: 8px; color: #0F172A; font-size: .875rem; font-weight: 500;
      padding: 8px 32px 8px 12px; cursor: pointer; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2364748B' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 10px center;
    }
    #pages-select:focus-visible { outline: 2px solid #2563EB; outline-offset: 2px; }

    .scan-error { display: block; font-size: .8125rem; color: #DC2626; font-weight: 500; min-height: 1.25em; }

    .spinner {
      width: 16px; height: 16px; flex-shrink: 0;
      border: 2px solid rgba(255,255,255,.3);
      border-top-color: #fff; border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Results */
    .results-card {
      background: #fff; border-radius: 20px;
      box-shadow: 0 24px 64px rgba(0,0,0,.3); padding: 40px;
    }
    .results-card h2 { font-size: 1.375rem; font-weight: 800; color: #0F172A; margin-bottom: 8px; outline: none; }
    .pages-note { font-size: .8125rem; color: #64748B; margin-bottom: 16px; }
    .ai-banner {
      display: flex; align-items: center; gap: 10px;
      background: linear-gradient(135deg, #EEF2FF, #F0FDF4);
      border: 1px solid #C7D2FE; border-radius: 10px;
      padding: 12px 16px; margin-bottom: 20px;
      font-size: .875rem; font-weight: 500; color: #3730A3;
    }
    .score-area { display: flex; align-items: center; gap: 24px; margin-bottom: 24px; }
    .score-ring-wrap { position: relative; flex-shrink: 0; width: 110px; height: 110px; }
    .score-ring { transform: rotate(-90deg); }
    .ring-bg   { fill: none; stroke: #E2E8F0; stroke-width: 9; }
    .ring-fill {
      fill: none; stroke: #2563EB; stroke-width: 9; stroke-linecap: round;
      stroke-dasharray: 314; stroke-dashoffset: 314;
      transition: stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1), stroke .3s;
    }
    .score-number {
      position: absolute; inset: 0; display: flex;
      align-items: center; justify-content: center;
      font-size: 2rem; font-weight: 900; color: #0F172A; line-height: 1;
    }
    .score-info { flex: 1; }
    .score-label { font-size: .875rem; color: #64748B; font-weight: 500; margin-bottom: 2px; }
    .score-value { font-size: 1.875rem; font-weight: 900; color: #0F172A; margin-bottom: 8px; letter-spacing: -.03em; }
    .verdict-badge {
      display: inline-flex; align-items: center;
      padding: 4px 14px; border-radius: 999px;
      font-size: .875rem; font-weight: 600; color: #fff;
    }
    .verdict-badge.low    { background: #166534; }
    .verdict-badge.medium { background: #92400E; }
    .verdict-badge.high   { background: #991B1B; }

    .results-divider { border: none; border-top: 1px solid #E2E8F0; margin: 18px 0; }

    .breakdown { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-bottom: 22px; }
    .bdi { border-radius: 10px; padding: 14px 8px; text-align: center; }
    .bdi.critical { background: #FEF2F2; }
    .bdi.serious  { background: #FFF7ED; }
    .bdi.moderate { background: #FFFBEB; }
    .bdi.minor    { background: #EFF6FF; }
    .bdi-count { display: block; font-size: 1.625rem; font-weight: 900; line-height: 1; margin-bottom: 3px; }
    .bdi.critical .bdi-count { color: #7F1D1D; }
    .bdi.serious  .bdi-count { color: #7C2D12; }
    .bdi.moderate .bdi-count { color: #78350F; }
    .bdi.minor    .bdi-count { color: #1E3A8A; }
    .bdi-label { font-size: .75rem; font-weight: 600; color: #64748B; }

    .btn-download {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 15px;
      background: linear-gradient(135deg, #2563EB, #7C3AED);
      color: #fff; border: none; border-radius: 12px;
      font-size: 1rem; font-weight: 700; text-decoration: none; cursor: pointer;
      box-shadow: 0 4px 18px rgba(37,99,235,.4);
      transition: filter .15s;
    }
    .btn-download:hover { filter: brightness(1.1); }
    .btn-download:focus-visible { outline: 3px solid #93C5FD; outline-offset: 3px; }
    .download-note { text-align: center; font-size: .8rem; color: #94A3B8; margin-top: 8px; }

    @media (max-width: 540px) {
      .scan-bar { flex-direction: column; gap: 6px; }
      #scan-btn { width: 100%; justify-content: center; }
      .score-area { flex-direction: column; text-align: center; }
      .breakdown { grid-template-columns: repeat(2,1fr); }
      .scanner-card, .results-card { padding: 24px 18px; }
      .admin-badge { top: 10px; right: 10px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ring-fill { transition: none; }
      .spinner   { animation: none; }
    }
  </style>
</head>
<body>

  <a href="#main-content" class="skip-link">Skip to main content</a>

  <div class="admin-badge" aria-hidden="true">Admin Mode</div>

  <div id="scan-status" role="status" aria-live="polite" aria-label="Scan status" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0"></div>

  <header>
    <div class="header">
      <a href="/" class="header-brand" aria-label="Auditly — go to homepage">
        ${SHIELD_SVG}
        <div>
          <div class="header-brand-name">Auditly</div>
          <div class="header-title">Admin Dashboard</div>
        </div>
      </a>
      <form method="POST" action="/admin/logout" style="margin:0">
        <button type="submit" class="btn-logout">Log Out</button>
      </form>
    </div>
  </header>

  <main id="main-content">
    <div class="main-wrap">

      <!-- Scanner card -->
      <div class="scanner-card">
        <h1 class="card-heading">Scan Any Website</h1>
        <form id="scan-form-el" novalidate aria-label="Website accessibility scanner">
          <label for="url-input" class="field-label">Website URL</label>
          <div class="scan-bar">
            <input
              type="url"
              id="url-input"
              name="url"
              autocomplete="url"
              required
              aria-describedby="url-error"
              placeholder="https://example.com"
              class="scan-input"
            >
            <button type="submit" id="scan-btn">
              <span id="btn-text">Scan Now →</span>
              <span id="btn-spinner" class="spinner" aria-hidden="true" hidden></span>
            </button>
          </div>
          <div class="pages-row">
            <label for="pages-select" class="pages-label">Pages to scan</label>
            <select id="pages-select" name="pages">
              <option value="1">Homepage only</option>
              <option value="5">Up to 5 pages</option>
              <option value="10">Up to 10 pages</option>
              <option value="25">Up to 25 pages</option>
            </select>
          </div>
          <span id="url-error" role="alert" class="scan-error"></span>
        </form>
      </div>

      <!-- Results (hidden until scan completes) -->
      <div id="results" hidden>
        <div class="results-card">
          <h2 id="results-heading" tabindex="-1">Scan Results</h2>
          <p id="pages-scanned-note" class="pages-note" hidden></p>

          <div id="ai-guide-banner" class="ai-banner" hidden>
            <span aria-hidden="true">✨</span>
            <span>AI Fix Guide included in the PDF report</span>
          </div>

          <div class="score-area">
            <div class="score-ring-wrap" aria-hidden="true">
              <svg class="score-ring" viewBox="0 0 120 120" width="110" height="110" focusable="false">
                <circle class="ring-bg"   cx="60" cy="60" r="50" />
                <circle class="ring-fill" id="ring-fill" cx="60" cy="60" r="50" />
              </svg>
              <span class="score-number" id="score-display" aria-hidden="true">—</span>
            </div>
            <div class="score-info">
              <p class="score-label">Compliance Score</p>
              <p class="score-value" id="score-text">—</p>
              <span id="verdict-badge" class="verdict-badge"></span>
            </div>
          </div>

          <hr class="results-divider" aria-hidden="true">

          <div class="breakdown" role="list" aria-label="Violation counts by severity">
            <div class="bdi critical" role="listitem">
              <span class="bdi-count" id="count-critical">0</span>
              <span class="bdi-label">Critical</span>
            </div>
            <div class="bdi serious" role="listitem">
              <span class="bdi-count" id="count-serious">0</span>
              <span class="bdi-label">Serious</span>
            </div>
            <div class="bdi moderate" role="listitem">
              <span class="bdi-count" id="count-moderate">0</span>
              <span class="bdi-label">Moderate</span>
            </div>
            <div class="bdi minor" role="listitem">
              <span class="bdi-count" id="count-minor">0</span>
              <span class="bdi-label">Minor</span>
            </div>
          </div>

          <a id="download-btn" href="#" class="btn-download" aria-describedby="download-note">
            <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
            Download Full PDF Report
          </a>
          <p id="download-note" class="download-note">Admin — no payment required</p>
        </div>
      </div>

    </div>
  </main>

  <script>
    'use strict';
    var CIRC = 314;
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var form        = document.getElementById('scan-form-el');
    var urlInput    = document.getElementById('url-input');
    var pagesSelect = document.getElementById('pages-select');
    var scanBtn     = document.getElementById('scan-btn');
    var btnText     = document.getElementById('btn-text');
    var btnSpinner  = document.getElementById('btn-spinner');
    var scanStatus  = document.getElementById('scan-status');
    var errorEl     = document.getElementById('url-error');
    var resultsEl   = document.getElementById('results');
    var ringFill    = document.getElementById('ring-fill');

    function verdictClass(label) {
      if (label.includes('Low'))    return 'low';
      if (label.includes('Medium')) return 'medium';
      return 'high';
    }
    function verdictStroke(label) {
      if (label.includes('Low'))    return '#166534';
      if (label.includes('Medium')) return '#92400E';
      return '#991B1B';
    }
    function showError(msg) {
      errorEl.textContent = msg;
      urlInput.setAttribute('aria-invalid', 'true');
      urlInput.focus();
    }
    function clearError() {
      errorEl.textContent = '';
      urlInput.removeAttribute('aria-invalid');
    }
    function setLoading(on) {
      if (on) {
        var pages = parseInt(pagesSelect.value, 10);
        btnText.textContent = 'Scanning…';
        btnSpinner.hidden   = false;
        scanBtn.disabled    = true;
        scanBtn.setAttribute('aria-disabled', 'true');
        scanStatus.textContent = pages > 1
          ? 'Scanning up to ' + pages + ' pages, this may take a moment…'
          : 'Scanning, please wait…';
      } else {
        btnText.textContent = 'Scan Now →';
        btnSpinner.hidden   = true;
        scanBtn.disabled    = false;
        scanBtn.removeAttribute('aria-disabled');
      }
    }

    function animateCount(el, target, duration) {
      if (reducedMotion) { el.textContent = target; return; }
      var t0 = performance.now();
      (function tick(now) {
        var p = Math.min((now - t0) / duration, 1);
        var e = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(e * target);
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    }

    function showResults(data) {
      document.getElementById('count-critical').textContent = data.counts.critical;
      document.getElementById('count-serious').textContent  = data.counts.serious;
      document.getElementById('count-moderate').textContent = data.counts.moderate;
      document.getElementById('count-minor').textContent    = data.counts.minor;
      document.getElementById('score-text').textContent     = data.score + ' / 100';

      var pagesNote = document.getElementById('pages-scanned-note');
      if (data.pagesScanned > 1) {
        pagesNote.textContent = data.pagesScanned + ' pages scanned — score is the average across all pages';
        pagesNote.hidden = false;
      } else {
        pagesNote.hidden = true;
      }

      var badge = document.getElementById('verdict-badge');
      badge.textContent = data.verdict;
      badge.className   = 'verdict-badge ' + verdictClass(data.verdict);

      // Admin: direct download without payment
      document.getElementById('download-btn').href = '/download/' + data.reportId;

      var aiBanner = document.getElementById('ai-guide-banner');
      if (aiBanner) aiBanner.hidden = !data.aiGuideIncluded;

      resultsEl.hidden = false;

      var offset = CIRC * (1 - data.score / 100);
      var color  = verdictStroke(data.verdict);
      if (reducedMotion) {
        ringFill.style.strokeDashoffset = offset;
        ringFill.style.stroke = color;
        document.getElementById('score-display').textContent = data.score;
      } else {
        requestAnimationFrame(function () {
          ringFill.style.stroke           = color;
          ringFill.style.strokeDashoffset = offset;
        });
        animateCount(document.getElementById('score-display'), data.score, 1200);
      }

      var total = data.counts.total;
      var pagesMsg = data.pagesScanned > 1 ? data.pagesScanned + ' pages scanned. ' : '';
      scanStatus.textContent =
        'Scan complete. ' + pagesMsg +
        'Score: ' + data.score + ' out of 100. ' +
        data.verdict + '. ' + total + ' violation' + (total !== 1 ? 's' : '') + ' found.';

      document.getElementById('results-heading').focus();
      if (!reducedMotion) {
        resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        resultsEl.scrollIntoView();
      }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearError();

      var url = urlInput.value.trim();
      if (!url) { showError('Please enter a website URL.'); return; }

      try {
        var parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      } catch (_) {
        showError('Please enter a valid URL, e.g. https://example.com');
        return;
      }

      setLoading(true);
      try {
        var maxPages = parseInt(pagesSelect.value, 10);
        var res  = await fetch('/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url, maxPages: maxPages }),
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Scan failed. Please try again.');
        showResults(data);
      } catch (err) {
        showError(err.message || 'Something went wrong. Please try again.');
      } finally {
        setLoading(false);
      }
    });
  </script>

</body>
</html>`;
}

function successPage(token) {
  const safeToken = /^[a-f0-9]{32}$/.test(String(token)) ? token : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Successful — Auditly</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700;14..32,800;14..32,900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(170deg, #020817 0%, #050D2B 55%, #030615 100%);
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      color: #fff; padding: 24px;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
      border-radius: 24px; padding: 48px 40px; width: 100%; max-width: 480px;
      text-align: center; box-shadow: 0 24px 64px rgba(0,0,0,.4);
    }
    .check-circle {
      width: 72px; height: 72px; border-radius: 50%;
      background: linear-gradient(135deg, #16A34A, #15803D);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 28px;
      box-shadow: 0 8px 24px rgba(22,163,74,.4);
    }
    .check-circle svg { width: 36px; height: 36px; }
    h1 {
      font-size: 1.625rem; font-weight: 900; margin-bottom: 12px;
      letter-spacing: -.025em; line-height: 1.2;
    }
    p {
      font-size: 1rem; color: rgba(255,255,255,.6);
      line-height: 1.65; margin-bottom: 32px;
    }
    .btn-download {
      display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 16px;
      background: linear-gradient(135deg, #16A34A, #15803D);
      color: #fff; border-radius: 14px;
      font-size: 1rem; font-weight: 700; text-decoration: none;
      box-shadow: 0 6px 24px rgba(22,163,74,.45);
      transition: filter .15s, transform .15s;
    }
    .btn-download:hover { filter: brightness(1.1); transform: translateY(-1px); }
    .btn-download:focus-visible { outline: 3px solid #86EFAC; outline-offset: 3px; }
    .expire-note {
      font-size: .8125rem; color: rgba(255,255,255,.35);
      margin-top: 14px; margin-bottom: 0;
    }
    .back {
      display: inline-block; margin-top: 20px;
      font-size: .875rem; color: rgba(255,255,255,.65); text-decoration: none;
    }
    .back:hover { color: rgba(255,255,255,.9); }
    .back:focus-visible { outline: 2px solid #93C5FD; border-radius: 2px; outline-offset: 2px; }
    .error-state { color: #FCA5A5; }
  </style>
</head>
<body>
  <main>
    <div class="card">
      ${safeToken ? `
      <div class="check-circle" aria-hidden="true">
        <svg aria-hidden="true" focusable="false" fill="none" stroke="white" stroke-width="3" viewBox="0 0 24 24">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <h1>Payment Successful!</h1>
      <p>Thank you for your purchase. Your full WCAG&nbsp;2.1&nbsp;AA accessibility report with AI fix guide is ready.</p>
      <a href="/download?token=${escapeHtml(safeToken)}" class="btn-download" aria-label="Download your accessibility report PDF">
        <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
        Download Your Report (PDF)
      </a>
      <p class="expire-note">This download link is valid for 15 minutes from your scan.</p>
      ` : `
      <div class="error-state" role="alert">
        <h1>Invalid or Expired Link</h1>
        <p>This download link is missing or has expired. Please return to the scanner and run a new scan.</p>
      </div>
      `}
      <a href="/" class="back">← Back to Auditly</a>
    </div>
  </main>
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// ── GET /admin ────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send('Admin access is not configured. Set ADMIN_PASSWORD in your environment.');
  }
  if (isAdminAuthed(req)) {
    return res.send(adminDashboardPage());
  }
  const showError = req.query.err === '1';
  res.send(adminLoginPage(showError));
});

// ── POST /admin/login ─────────────────────────────────────────────────────────

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.status(503).send('Admin not configured.');
  }

  if (!password || password !== expected) {
    return res.redirect(302, '/admin?err=1');
  }

  const sid = crypto.randomBytes(24).toString('hex');
  adminSessions.add(sid);

  const maxAge = 24 * 60 * 60;
  res.setHeader('Set-Cookie', `auditly_admin=${sid}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Path=/`);
  res.redirect(302, '/admin');
});

// ── POST /admin/logout ────────────────────────────────────────────────────────

app.post('/admin/logout', (req, res) => {
  const { auditly_admin: sid } = parseCookies(req);
  if (sid) adminSessions.delete(sid);
  res.setHeader('Set-Cookie', 'auditly_admin=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
  res.redirect(302, '/');
});

// ── GET /success ──────────────────────────────────────────────────────────────

app.get('/success', (req, res) => {
  res.send(successPage(req.query.token));
});

// ── GET /checkout ─────────────────────────────────────────────────────────────

app.get('/checkout', (req, res) => {
  const { token } = req.query;
  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).send('Invalid token.');
  }
  const entry = useToken(token);
  if (!entry) {
    return res.status(410).send('This scan session has expired. Please scan again.');
  }

  const checkoutUrl = process.env.LEMONSQUEEZY_CHECKOUT_URL;
  if (!checkoutUrl) {
    return res.status(503).send('Payment not configured. Contact support.');
  }

  const host = `${req.protocol}://${req.get('host')}`;
  const successUrl = `${host}/success?token=${encodeURIComponent(token)}`;

  const separator = checkoutUrl.includes('?') ? '&' : '?';
  const redirectTo = `${checkoutUrl}${separator}checkout[redirect_url]=${encodeURIComponent(successUrl)}`;

  res.redirect(302, redirectTo);
});

// ── GET /download (token-based, post-payment) ─────────────────────────────────

app.get('/download', (req, res) => {
  const { token } = req.query;
  if (!token || !/^[a-f0-9]{32}$/.test(String(token))) {
    return res.status(400).send('Invalid download token.');
  }
  const entry = useToken(token);
  if (!entry) {
    return res.status(410).send('This download link has expired (valid for 15 minutes). Please scan again.');
  }
  const fp = path.join(REPORTS, `${entry.reportId}.pdf`);
  if (!fs.existsSync(fp)) {
    return res.status(404).send('Report not found or expired.');
  }
  res.download(fp, 'accessibility-report.pdf');
});

// ── POST /scan ────────────────────────────────────────────────────────────────

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

  // Clean up stale reports and expired tokens
  try {
    const cutoff = Date.now() - REPORT_TTL;
    for (const f of fs.readdirSync(REPORTS)) {
      const fp = path.join(REPORTS, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch { /* non-fatal */ }
  pruneTokens();

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

    const token = makeToken(reportId);

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
      token,
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

// ── GET /download/:id (direct, admin / existing links) ────────────────────────

app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{24}$/.test(id))
    return res.status(400).send('Invalid report ID.');

  const fp = path.join(REPORTS, `${id}.pdf`);
  if (!fs.existsSync(fp))
    return res.status(404).send('Report not found or expired (reports are kept for 1 hour).');

  res.download(fp, 'accessibility-report.pdf');
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const aiEnabled = !!process.env.ANTHROPIC_API_KEY;
  const lsEnabled = !!process.env.LEMONSQUEEZY_CHECKOUT_URL;
  const adminEnabled = !!process.env.ADMIN_PASSWORD;
  console.log(`\n  Auditly  →  http://localhost:${PORT}`);
  console.log(`  AI Fix Guide  →  ${aiEnabled ? 'enabled (' + (process.env.AI_MODEL || 'claude-sonnet-4-5') + ')' : 'disabled (add ANTHROPIC_API_KEY)'}`);
  console.log(`  Payment       →  ${lsEnabled ? 'enabled (Lemon Squeezy)' : 'disabled (add LEMONSQUEEZY_CHECKOUT_URL)'}`);
  console.log(`  Admin panel   →  ${adminEnabled ? 'enabled at /admin' : 'disabled (add ADMIN_PASSWORD)'}\n`);
});
