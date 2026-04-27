# Use Google Cloud SDK base image which has Python, gcloud, and basic tools
FROM google/cloud-sdk:latest

# Install Python pip, venv, and kubectl, and clean up apt cache
RUN apt-get update && \
    apt-get install -y python3-pip python3-venv kubectl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies for ADK and GKE Sandbox SDK
# Using --no-cache-dir to keep image size small
RUN pip3 install --break-system-packages --no-cache-dir \
    google-adk \
    k8s-agent-sandbox==0.4.2 \
    rich

# Set working directory
WORKDIR /app

# Copy the agent source code
# Note: Build context should be the repository root
COPY demo_agent /app/demo_agent

# Copy and configure entrypoint script
COPY demo_agent/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose the port Cloud Run will inject (PORT env var)
EXPOSE 8080

# Set the entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]
