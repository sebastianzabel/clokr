#!/bin/sh

echo "🔄 Waiting for database..."
cd /app/packages/db

# Wait for DB to be reachable (up to 30s)
for i in $(seq 1 30); do
  if node -e "const net=require('net');const s=net.connect(5432,'${DATABASE_URL##*@}'.split(':')[0].split('/')[0],()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "✅ Database reachable"
    break
  fi
  echo "  Waiting... ($i/30)"
  sleep 1
done

echo "🔄 Syncing database schema..."

# Retry db push up to 3 times (DNS can be flaky in K8s)
RETRIES=3
for i in $(seq 1 $RETRIES); do
  if [ -d "prisma/migrations" ] && [ "$(ls -A prisma/migrations 2>/dev/null)" ]; then
    echo "📦 Running migrations (attempt $i)..."
    npx prisma migrate deploy && break
  else
    echo "📦 No migrations found, using db push (attempt $i)..."
    npx prisma db push && break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    echo "❌ Database sync failed after $RETRIES attempts!"
    exit 1
  fi
  echo "⚠️  Retrying in 5s..."
  sleep 5
done

echo "✅ Database schema synced"

if [ "${SEED_DEMO_DATA:-false}" = "true" ]; then
  echo "🌱 Running database seed..."
  npx tsx src/seed.ts || echo "ℹ️  Seed skipped (may already exist)"
else
  echo "ℹ️  Seed skipped (SEED_DEMO_DATA not set to true)"
fi

echo "🚀 Starting Clokr API..."
cd /app
exec su-exec clokr node apps/api/dist/index.js
