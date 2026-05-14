FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . .
RUN npm run build:favicon \
    && mkdir -p reports \
    && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 10000
CMD ["npm", "start"]
