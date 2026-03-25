#!/bin/sh

echo "🔄 Syncing database schema..."
cd /app/packages/db

# Check if migration directory has migrations
if [ -d "prisma/migrations" ] && [ "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "📦 Running migrations..."
  npx prisma migrate deploy || {
    echo "❌ Migration failed!"
    exit 1
  }
else
  echo "📦 No migrations found, using db push..."
  npx prisma db push || {
    echo "❌ Database sync failed!"
    exit 1
  }
fi

echo "✅ Database schema synced"

if [ "${SEED_DEMO_DATA:-true}" = "true" ]; then
  echo "🌱 Running database seed..."
  npx tsx src/seed.ts || echo "ℹ️  Seed skipped (may already exist)"
else
  echo "ℹ️  Seed skipped (SEED_DEMO_DATA=false)"
fi

echo "🚀 Starting Clokr API..."
cd /app
exec su-exec clokr node apps/api/dist/index.js
