#!/bin/bash
# Deployment script for Plaid MCP Server

set -e  # Exit immediately if a command exits with a non-zero status

# Check for required environment variables
if [ -z "$GCP_PROJECT_ID" ]; then
  echo "Error: GCP_PROJECT_ID environment variable is not set"
  exit 1
fi

if [ -z "$GCP_INSTANCE_NAME" ]; then
  echo "Error: GCP_INSTANCE_NAME environment variable is not set"
  exit 1
fi

if [ -z "$GCP_ZONE" ]; then
  echo "Error: GCP_ZONE environment variable is not set"
  exit 1
fi

echo "Building the application..."
npm run build

echo "Preparing deployment package..."
# Create a temp directory for the deployment package
DEPLOY_DIR=$(mktemp -d)

# Copy necessary files
mkdir -p $DEPLOY_DIR/dist
cp -r dist/* $DEPLOY_DIR/dist/
cp package.json $DEPLOY_DIR/
cp .env $DEPLOY_DIR/ || cp .env.example $DEPLOY_DIR/.env
cp -r node_modules $DEPLOY_DIR/ || echo "Warning: node_modules not found, will need to run npm install on server"

# Create a tar file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DEPLOY_FILE="deploy_$TIMESTAMP.tar.gz"
tar -czf $DEPLOY_FILE -C $DEPLOY_DIR .

echo "Uploading deployment package to GCP VM..."
gcloud compute scp $DEPLOY_FILE ${GCP_INSTANCE_NAME}:~/ --zone=$GCP_ZONE --project=$GCP_PROJECT_ID

echo "Deploying on GCP VM..."
gcloud compute ssh ${GCP_INSTANCE_NAME} --zone=$GCP_ZONE --project=$GCP_PROJECT_ID \
  --command="
    mkdir -p ~/plaid-mcp-server
    tar -xzf ~/${DEPLOY_FILE} -C ~/plaid-mcp-server
    cd ~/plaid-mcp-server
    npm install --only=production
    pm2 stop plaid-mcp-server || true
    pm2 start dist/server.js --name plaid-mcp-server
    pm2 save
    rm ~/${DEPLOY_FILE}
  "

# Clean up local temporary files
rm $DEPLOY_FILE
rm -rf $DEPLOY_DIR

echo "Deployment completed successfully!"