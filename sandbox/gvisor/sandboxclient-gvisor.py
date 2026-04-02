import time
import logging
import sys
from concurrent.futures import ThreadPoolExecutor

# Initialize logging BEFORE importing the library to ensure our config takes precedence
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
    logging.info("[%d] Starting gVisor sandbox task...", idx)
    
    # Using the gVisor sandbox template
    client = SandboxClient(
        template_name="python-runtime-template-gvisor-filestore-pvc",
        namespace="default",
        gateway_name="external-http-gateway",
        gateway_namespace="default"
    )
    
    try:
        logging.info("[%d] Initializing claim and waiting for ready...", idx)
        with client as sandbox:
            t2 = current_milli_time()
            sbx_name = sandbox.claim_name
            logging.info("[%d] gVisor Sandbox %s ready in %d ms", idx, sbx_name, (t2 - t1))
            
            logging.info("[%d] Executing 'df -Th'...", idx)
            result = sandbox.run("df -Th")
            
            print(f"\n--- [%d] Output for {sbx_name} ---" % idx)
            print(result.stdout)
            print("--- [%d] End Output ---\n" % idx)
            
            t3 = current_milli_time()
            logging.info("[%d] Execution took %d ms ", idx, (t3 - t2))
            
    except Exception as e:
        logging.error("[%d] gVisor Sandbox execution failed: %s", idx, e, exc_info=True)
        
    t4 = current_milli_time()
    logging.info("[%d] Task completed in %d ms", idx, (t4 - t1))

if __name__ == "__main__":
    count = 15  # Parallel threads as per your Kata script
    print(f"DEBUG: Starting gVisor test with {count} thread(s)...")
    logging.info("Starting gVisor test with %d thread(s)...", count)
    
    with ThreadPoolExecutor(max_workers=count) as executor:
        futures = [executor.submit(run_sandbox, i) for i in range(count)]
        for f in futures:
            try:
                f.result()
            except Exception as e:
                logging.error("Thread crashed: %s", e)
