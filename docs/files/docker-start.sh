#!/bin/bash
set -e

cleanup() {
    echo "Stopping PostgreSQL..."
    sudo -u postgres /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/17/main stop || true
    exit 0
}

trap cleanup SIGTERM SIGINT EXIT

# Database credentials matching framework/.env.default
POSTGRES_USER=pg
POSTGRES_PASSWORD=pg
POSTGRES_DB=dev

# Ensure log directory exists and has correct permissions
# Use /app/logs for easier volume mounting to host
mkdir -p /app/logs
chmod 777 /app/logs  # Allow writing from any user (needed for postgres user)

# Create log file in /app/logs (will be mapped to host)
POSTGRES_LOG="/app/logs/postgresql.log"
touch "$POSTGRES_LOG"
chmod 666 "$POSTGRES_LOG"  # Allow postgres user to write

# Ensure data directory has correct permissions
chown -R postgres:postgres /var/lib/postgresql
chmod 700 /var/lib/postgresql/17/main

# Check if PostgreSQL is properly initialized
# We need both PG_VERSION AND postgresql.conf to exist
if [ ! -f /var/lib/postgresql/17/main/PG_VERSION ] || [ ! -f /var/lib/postgresql/17/main/postgresql.conf ]; then
    echo "PostgreSQL data directory not properly initialized. Initializing now..."
    
    # Remove incomplete initialization if it exists
    if [ -d /var/lib/postgresql/17/main ] && [ ! -f /var/lib/postgresql/17/main/postgresql.conf ]; then
        echo "Removing incomplete data directory..."
        rm -rf /var/lib/postgresql/17/main/*
    fi
    
    echo "Running initdb as postgres user..."
    
    INIT_OUTPUT=$(sudo -u postgres /usr/lib/postgresql/17/bin/initdb -D /var/lib/postgresql/17/main --auth-local=trust --auth-host=md5 2>&1)
    INIT_EXIT_CODE=$?
    
    if [ $INIT_EXIT_CODE -ne 0 ]; then
        echo "ERROR: initdb failed with exit code $INIT_EXIT_CODE!"
        echo "Output: $INIT_OUTPUT"
        exit 1
    fi
    
    echo "initdb completed successfully"
    echo "Verifying initialization files..."
    
    # Verify critical files exist
    if [ ! -f /var/lib/postgresql/17/main/PG_VERSION ]; then
        echo "ERROR: PG_VERSION file missing after initialization!"
        exit 1
    fi
    
    if [ ! -f /var/lib/postgresql/17/main/postgresql.conf ]; then
        echo "ERROR: postgresql.conf file missing after initialization!"
        exit 1
    fi
    
    echo "PostgreSQL initialized successfully. PG_VERSION: $(cat /var/lib/postgresql/17/main/PG_VERSION)"
    echo "Configuring PostgreSQL..."
    
    # Configure pg_hba.conf - allow connections from anywhere
    # First, backup original and create new one with our settings
    sudo -u postgres sh -c "cp /var/lib/postgresql/17/main/pg_hba.conf /var/lib/postgresql/17/main/pg_hba.conf.backup" || true
    
    # Add our entries (local connections use trust, network uses md5)
    sudo -u postgres sh -c "echo 'host all all 0.0.0.0/0 md5' >> /var/lib/postgresql/17/main/pg_hba.conf" || echo "Warning: Failed to add pg_hba.conf entry"
    sudo -u postgres sh -c "echo 'host all all ::/0 md5' >> /var/lib/postgresql/17/main/pg_hba.conf" || echo "Warning: Failed to add IPv6 pg_hba.conf entry"
    
    echo "pg_hba.conf configured"
    
    # Configure postgresql.conf - listen on all addresses
    sudo -u postgres sh -c "echo '' >> /var/lib/postgresql/17/main/postgresql.conf" || true
    sudo -u postgres sh -c "echo '# Custom configuration' >> /var/lib/postgresql/17/main/postgresql.conf" || true
    sudo -u postgres sh -c "echo \"listen_addresses = '*'\" >> /var/lib/postgresql/17/main/postgresql.conf" || echo "Warning: Failed to set listen_addresses"
    sudo -u postgres sh -c "echo 'port = 5432' >> /var/lib/postgresql/17/main/postgresql.conf" || echo "Warning: Failed to set port"
    sudo -u postgres sh -c "echo 'max_connections = 100' >> /var/lib/postgresql/17/main/postgresql.conf" || echo "Warning: Failed to set max_connections"
    
    echo "PostgreSQL configured successfully"
else
    echo "PostgreSQL data directory already initialized"
fi

# Check if PostgreSQL is already running
if sudo -u postgres /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/17/main status > /dev/null 2>&1; then
    echo "PostgreSQL is already running"
else
    echo "Starting PostgreSQL..."
    echo "Data directory: /var/lib/postgresql/17/main"
    echo "Log file: $POSTGRES_LOG (mapped to host)"
    
    # Verify data directory exists and has correct structure
    if [ ! -d /var/lib/postgresql/17/main ]; then
        echo "ERROR: Data directory does not exist!"
        exit 1
    fi
    
    if [ ! -f /var/lib/postgresql/17/main/PG_VERSION ]; then
        echo "ERROR: PostgreSQL not initialized! PG_VERSION file missing."
        exit 1
    fi
    
    # Try to start PostgreSQL and capture output
    echo "Attempting to start PostgreSQL..."
    START_OUTPUT=$(sudo -u postgres /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/17/main -l "$POSTGRES_LOG" start -w -t 30 2>&1)
    START_EXIT_CODE=$?
    
    # Always show logs and debug info
    echo ""
    echo "=== Start Command Output ==="
    echo "$START_OUTPUT"
    echo "=== Exit Code: $START_EXIT_CODE ==="
    echo ""
    
    if [ $START_EXIT_CODE -ne 0 ]; then
        echo "ERROR: PostgreSQL failed to start!"
        echo ""
        echo "=== Checking PostgreSQL Log ==="
        if [ -f "$POSTGRES_LOG" ]; then
            echo "Log file exists at $POSTGRES_LOG, showing contents:"
            cat "$POSTGRES_LOG"
        else
            echo "Log file does not exist at $POSTGRES_LOG"
            echo "Checking if log directory exists:"
            ls -la /app/logs/ || true
        fi
        echo "=== End of Log ==="
        echo ""
        echo "=== Data Directory Contents ==="
        ls -la /var/lib/postgresql/17/main/ | head -20 || true
        echo ""
        echo "=== Permissions Check ==="
        ls -ld /var/lib/postgresql/17/main || true
        echo ""
        echo "=== PostgreSQL Configuration Files ==="
        if [ -f /var/lib/postgresql/17/main/postgresql.conf ]; then
            echo "postgresql.conf exists"
            tail -20 /var/lib/postgresql/17/main/postgresql.conf || true
        else
            echo "postgresql.conf does not exist!"
        fi
        echo ""
        if [ -f /var/lib/postgresql/17/main/pg_hba.conf ]; then
            echo "pg_hba.conf exists"
            tail -10 /var/lib/postgresql/17/main/pg_hba.conf || true
        else
            echo "pg_hba.conf does not exist!"
        fi
        echo ""
        echo "=== Trying to start PostgreSQL directly for debugging ==="
        echo "This will show immediate error messages:"
        sudo -u postgres /usr/lib/postgresql/17/bin/postgres -D /var/lib/postgresql/17/main -c listen_addresses='*' 2>&1 | head -30 || true
        exit 1
    fi
fi

echo "Waiting for PostgreSQL to be ready..."
until sudo -u postgres /usr/lib/postgresql/17/bin/pg_isready > /dev/null 2>&1; do
    sleep 1
done
echo "PostgreSQL is ready!"

export PGPASSWORD=${POSTGRES_PASSWORD}

echo "Setting up PostgreSQL user and database..."

# Create user if it doesn't exist (initdb only creates 'postgres' superuser)
sudo -u postgres psql -c "SELECT 1 FROM pg_roles WHERE rolname='${POSTGRES_USER}'" | grep -q 1 && {
    sudo -u postgres psql -c "ALTER USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';" 2>&1
} || {
    echo "Creating user ${POSTGRES_USER}..."
    sudo -u postgres psql -c "CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}' SUPERUSER;" 2>&1
}

# Create database if it doesn't exist
sudo -u postgres psql -c "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'" | grep -q 1 || {
    echo "Creating database ${POSTGRES_DB}..."
    sudo -u postgres psql -c "CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};" 2>&1
}

# Create pgvector extension
sudo -u postgres psql -d ${POSTGRES_DB} -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || echo "Warning: Could not create vector extension"

echo "PostgreSQL setup completed"

echo "Initializing backend (.env and secrets)..."
cd /app/backend
bun run init || echo "Init completed (or already initialized)"

echo "Running migrations..."
bun run framework:migrate || echo "Framework migrations completed (or already applied)"
bun run app:migrate || echo "App migrations completed (or already applied)"

# Seed demo data (Dockerfile.dev is only used for dev/staging)
echo "Seeding database with demo data..."
cd /app/backend
bun run add-demo-data || echo "Warning: Seeding failed or partially completed"

echo "Starting application..."
cd /app/backend
exec bun --hot run src/index.ts
