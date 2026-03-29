from k8s_agent_sandbox import SandboxClient
import time
from concurrent.futures import ThreadPoolExecutor
import logging
import sys

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
def current_milli_time():
    return round(time.time() * 1000)

def run_sandbox():
    t1 = current_milli_time()
    logging.info("client start time: %d ", t1)
    with SandboxClient(
        template_name="python-runtime-template-kata-filestore-pvc",
        gateway_name="external-http-gateway", 
        namespace="default"
    ) as sandbox:
        t2 = current_milli_time()
        sbx_name = sandbox.claim_name
        logging.info("%s ready time %d ", sbx_name, (t2 - t1))
        logging.info(sandbox.run("df -Th").stdout)
        t3 = current_milli_time()
        logging.info("%s total time %d ", sbx_name, (t3 - t2))
    t4 = current_milli_time()
    logging.info("client total time for %s: %d ", sbx_name, (t4 - t1))

if __name__ == "__main__":
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        logger.addHandler(logging.StreamHandler(sys.stdout))
        
    count = 15  # Number of parallel sandboxes
    with ThreadPoolExecutor(max_workers=count) as executor:
        futures = [executor.submit(run_sandbox) for _ in range(count)]
        for f in futures:
            try:
                f.result()
            except Exception as e:
                logging.error(f"Sandbox task failed: {e}", exc_info=True)
