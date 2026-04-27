#!/bin/bash
set -e

echo "================================================="
echo "🤖 Starting GKE Sandbox Demo Agent Entrypoint"
echo "================================================="

# Check required environment variables
echo "🔍 Checking environment variables..."
if [ -z "$PROJECT_ID" ]; then
    echo "❌ ERROR: PROJECT_ID environment variable is not set!"
    exit 1
fi

if [ -z "$REGION" ]; then
    echo "❌ ERROR: REGION environment variable is not set! Defaulting to us-central1."
    export REGION="us-central1"
fi

echo "  - Project ID: $PROJECT_ID"
echo "  - Region: $REGION"
echo "  - Port: ${PORT:-8080}"

# Get GKE cluster credentials
echo "🔑 Fetching GKE cluster credentials..."
# The cluster name 'ai-sandbox-cluster' is hardcoded as per the repository standard.
gcloud container clusters get-credentials ai-sandbox-cluster \
    --region "$REGION" \
    --project "$PROJECT_ID"

echo "✅ GKE credentials configured successfully."

# Verify kubectl connectivity
echo "🌐 Verifying cluster connectivity..."
if kubectl cluster-info >/dev/null 2>&1; then
    echo "✅ Connected to GKE cluster successfully."
else
    echo "❌ WARNING: Could not connect to GKE cluster. Retrying in 5 seconds..."
    sleep 5
    if ! kubectl cluster-info; then
        echo "❌ ERROR: Failed to connect to GKE cluster. Please verify Service Account permissions (roles/container.developer)."
        exit 1
    fi
fi

# Start the ADK Web Server
echo "🚀 Starting ADK Web UI..."
echo "Serving agents from directory: /app"
# We run in /app, which contains the 'demo_agent' folder.
# 'adk web .' will scan /app and find 'demo_agent' as an available app.
exec adk web . --host 0.0.0.0 --port "${PORT:-8080}" --log_level info
