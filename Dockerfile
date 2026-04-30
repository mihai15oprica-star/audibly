FROM node:20-alpine

# Install system dependencies required by Playwright/Chromium
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-dejavu \
  nodejs \
  npm

WORKDIR /app

# Set environment to prevent Playwright from trying to download Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright-cache
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=false

# Copy package files
COPY package*.json ./

# Install dependencies (playwright will try to install browsers here)
RUN npm ci --only=production

# Install Chromium browser using Playwright (point to system Chromium)
RUN npx playwright install chromium --with-deps

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]
