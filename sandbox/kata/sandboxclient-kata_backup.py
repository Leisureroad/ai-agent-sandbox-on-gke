import time
import logging
import sys
from concurrent.futures import ThreadPoolExecutor

# Initialize logging BEFORE importing the library to ensure our config takes precedence
# Or use force=True if on Python 3.8+
logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout,
    force=True  # Force this config if another has been set
)

from k8s_agent_sandbox import SandboxClient

def current_milli_time():
    return round(time.time() * 1000)

def run_sandbox(idx):
    t1 = current_milli_time()
    logging.info("[%d] Starting sandbox task...", idx)
    
    gateway_url = "http://35.244.244.184"
    template_name = "openclaw-template-kata"
    
    try:
        logging.info("[%d] Initializing claim and waiting for ready...", idx)
        with SandboxClient(template_name=template_name, api_url=gateway_url, server_port=18790) as sandbox:
            t2 = current_milli_time()
            sbx_name = sandbox.claim_name
            logging.info("[%d] Sandbox %s ready in %d ms", idx, sbx_name, (t2 - t1))
            
            logging.info("[%d] Executing 'openclaw --help'...", idx)
            result = sandbox.run("openclaw --help")
            
            print(f"\n--- [%d] Output for {sbx_name} ---" % idx)
            print(result.stdout)
            print("--- [%d] End Output ---\n" % idx)
            
            t3 = current_milli_time()
            logging.info("[%d] Execution took %d ms ", idx, (t3 - t2))
            
    except Exception as e:
        logging.error("[%d] Sandbox execution failed: %s", idx, e, exc_info=True)
        
    t4 = current_milli_time()
    logging.info("[%d] Task completed in %d ms", idx, (t4 - t1))

if __name__ == "__main__":
    count = 1  # Recommended: Start with 1 to verify logging and connectivity
    print(f"DEBUG: Starting test with {count} thread(s)...")
    logging.info("Starting test with %d thread(s)...", count)
    
    with ThreadPoolExecutor(max_workers=count) as executor:
        futures = [executor.submit(run_sandbox, i) for i in range(count)]
        for f in futures:
            try:
                f.result()
            except Exception as e:
                logging.error("Thread crashed: %s", e)
