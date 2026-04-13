export OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
kubectl apply -f openclaw-config.yaml
sed "s/dummy-token-for-sandbox/$OPENCLAW_GATEWAY_TOKEN/g" openclaw-sandbox.yaml | kubectl apply -f -
kubectl port-forward pod/openclaw-sandbox 18789:18789


Access the Web UI: Open http://localhost:18789 in your browser.


kubectl exec -it openclaw-sandbox -- openclaw --help
