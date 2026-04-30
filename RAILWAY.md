# Railway Deployment Guide

## Configuration Files Created ✅

- **railway.json**: Build and start configuration for Railway
- **.railwayignore**: Excludes unnecessary files from deployment

## Environment Variables Required in Railway Dashboard

Add these variables in your Railway project settings:

### 1. **ANTHROPIC_API_KEY** (Required for AI features)
- **Purpose**: Enables AI-powered fix recommendations in accessibility reports
- **Value**: Your Anthropic API key (get from https://console.anthropic.com)
- **If omitted**: AI features will be disabled, but scanning still works

### 2. **AI_MODEL** (Optional)
- **Purpose**: Specifies the Claude model for AI recommendations
- **Value**: `claude-sonnet-4-5` (default)
- **Options**: Any valid Claude model (e.g., `claude-opus-4-1`, `claude-3-5-sonnet-20241022`)
- **If omitted**: Defaults to `claude-sonnet-4-5`

### 3. **PORT** (Automatically handled)
- Railway automatically sets this
- Default fallback: 3000
- No action needed in dashboard

## Deployment Steps

1. **Connect your Railway project**
   - Link this repository to Railway via GitHub

2. **Add environment variables**
   - Go to Railway Project Settings → Variables
   - Add `ANTHROPIC_API_KEY` with your API key
   - Optionally add `AI_MODEL` if using a different Claude model

3. **Deploy**
   - Railway will automatically:
     - Install dependencies
     - Run `postinstall` script to download Chromium
     - Start the server via `npm start`

4. **Verify deployment**
   - Check logs for: "Auditly → http://localhost:PORT"
   - AI Guide status will show as enabled/disabled

## Build Process

The deployment uses **nixpacks** which:
- Detects Node.js environment
- Runs `npm ci` (clean install for reproducible builds)
- Executes `postinstall` script to install Chromium for Playwright
- Starts the app with `npm start`

## Expected Build Time

~3-5 minutes (mostly downloading Chromium browser binaries)

## Testing Locally Before Deploy

```bash
# Install dependencies
npm install

# Start server
npm start

# Visit http://localhost:3000
```

## Files Verified for Production

✅ server.js - Uses `process.env.PORT` with 3000 fallback
✅ lib/ai.js - Uses `process.env.ANTHROPIC_API_KEY` and `process.env.AI_MODEL`
✅ lib/core.js - No hardcoded credentials
✅ package.json - All scripts configured
✅ .env.example - Documented for reference

## Storage Notes

- Reports are stored in `/reports` directory during request processing
- Reports expire after 1 hour (TTL cleanup runs automatically)
- Use Railway's persistent storage if you need long-term report archival
