# ================================================================
# Multi-stage Dockerfile for Oracle MCP Server
# ================================================================

# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for building)
RUN npm ci || npm install

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Stage 2: Runtime
FROM node:20-slim AS runtime

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev || npm install --omit=dev

# Copy built output from builder stage
COPY --from=builder /app/dist ./dist

# Copy .env.example for reference
COPY .env.example .env.example

# Create a non-root user for security
RUN groupadd -r mcp && useradd -r -g mcp -s /bin/bash mcp
RUN chown -R mcp:mcp /app
USER mcp

# Environment variables (override at runtime)
ENV NODE_ENV=production
ENV LOG_LEVEL=INFO
# Oracle connection (must be provided at runtime)
# ENV ORACLE_USER=hr
# ENV ORACLE_PASSWORD=your_password
# ENV ORACLE_CONNECT_STRING=localhost:1521/ORCLPDB1

# Health check (optional: requires curl)
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "process.exit(0)"

# Start the MCP server
CMD ["node", "dist/index.js"]
