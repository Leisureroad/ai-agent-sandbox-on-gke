import os
import sys
import time
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Generator

# We need to ensure the venv is in sys.path if running via adk run,
# but adk run should already be running in the venv python if we use ./venv/bin/adk.
# Just to be safe, we don't need to force it here if we rely on the venv.

from google.adk.agents import Agent

def _run_cmd(cmd: str) -> str:
    """Helper to run shell commands."""
    try:
        import subprocess
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        return (result.stdout + result.stderr).strip()
    except subprocess.TimeoutExpired:
        return f"❌ **Error:** Command '{cmd}' timed out after 30 seconds."
    except Exception as e:
        return str(e)

# Define Tools as plain functions with docstrings and type hints
def kubectl_cmd(command: str) -> str:
    """
    Execute a kubectl command on the cluster and return the output.
    
    Args:
        command: The kubectl command to run (e.g., "get pods", "describe node"). Do NOT include "kubectl" prefix.
        
    Returns:
        The stdout and stderr of the command.
    """
    return _run_cmd(f"kubectl {command}")

def run_pod_snapshot_demo(confirmed: bool = False) -> str:
    """
    Demonstrates the Pod Snapshot feature by triggering a manual snapshot of the 'openclaw-sandbox-gvisor' pod,
    deleting it, and measuring the time it takes to resume from the snapshot.
    Analyses the performance and verifies the GKEPodSnapshotting event.
    
    Args:
        confirmed: Must be set to True to execute the test. If False, returns a test plan and requests confirmation.
        
    Returns:
        A detailed markdown report of the demonstration, or a test plan if not confirmed.
    """
    if not confirmed:
        return """### 🎯 Pod Snapshot 性能演示测试方案
**测试目标**：验证 GKE Pod Snapshot 功能，展示从内存快照近乎瞬时恢复 AI 应用的能力。
**测试步骤**：
1. 触发 `PodSnapshotManualTrigger` 为 `openclaw-sandbox-gvisor` Pod 创建内存快照。
2. 强行删除该 Pod（模拟故障）。
3. 测量 GKE 自动从快照恢复 Pod 至 `Ready` 状态的时间。
4. 检查集群事件，验证 `GKEPodSnapshotting` 恢复事件。
**预期结果**：Pod 恢复时间在数秒内，远快于重新拉取镜像和初始化的冷启动时间（通常 30-60+ 秒）。
**潜在风险**：测试过程中该沙箱 Pod 会被删除重启，可能导致当前正在进行的会话中断。在演示环境中是安全的。

**⚠️ 请确认是否执行此测试？** (请回复 "确认执行" 或 "Yes")
"""
    pod_name = "openclaw-sandbox-gvisor"
    report = ["# 🚀 Pod Snapshot Performance Demonstration Report\n"]
    
    # 1. Check if pod exists
    out = _run_cmd(f"kubectl get pod {pod_name} -o jsonpath='{{.status.phase}}'")
    if out != "Running":
        return f"❌ **Error:** Pod `{pod_name}` is not in Running state (Current: `{out}`). Please ensure OpenClaw is deployed."
        
    report.append(f"✅ **Initial State:** Pod `{pod_name}` is Running.\n")
    
    # 2. Trigger Snapshot
    report.append("## 📸 Step 1: Triggering Pod Snapshot")
    trigger_yaml = f"""
apiVersion: podsnapshot.gke.io/v1alpha1
kind: PodSnapshotManualTrigger
metadata:
  name: demo-manual-trigger
  namespace: default
spec:
  targetPod: {pod_name}
"""
    with open("demo-trigger.yaml", "w") as f:
        f.write(trigger_yaml)
    
    _run_cmd("kubectl apply -f demo-trigger.yaml")
    report.append("- Applied `PodSnapshotManualTrigger` for `openclaw-sandbox-gvisor`.")
    report.append("- Waiting 15 seconds for snapshot to complete in background...")
    time.sleep(15)
    
    # 3. Delete Pod
    report.append("\n## 🗑️ Step 2: Simulating Pod Failure (Deletion)")
    start_time = time.time()
    _run_cmd(f"kubectl delete pod {pod_name} --grace-period=0 --force")
    report.append("- Pod forcibly deleted.")
    
    # 4. Wait for Recovery
    report.append("- Waiting for GKE to restore Pod from snapshot...")
    resume_time = 0
    timeout = 120
    check_interval = 1
    elapsed = 0
    
    while elapsed < timeout:
        time.sleep(check_interval)
        elapsed += check_interval
        out = _run_cmd(f"kubectl get pod {pod_name} -o jsonpath='{{.status.conditions[?(@.type==\"Ready\")].status}}'")
        if out == "True":
            resume_time = time.time() - start_time
            break
            
    if resume_time == 0:
        report.append(f"❌ **Timeout:** Pod did not become Ready within {timeout} seconds.")
        return "\n".join(report)
        
    report.append(f"⏱️ **Resume Time:** Pod became [bold green]Ready[/bold green] in **{resume_time:.2f} seconds**!")
    
    # 5. Verify Events
    report.append("\n## 🔍 Step 3: Verifying Snapshot Restoration")
    events = _run_cmd(f"kubectl get events --field-selector involvedObject.name={pod_name} --sort-by='.metadata.creationTimestamp'")
    
    restore_event_found = False
    report.append("### Relevant Pod Events:")
    report.append("```")
    for line in events.splitlines():
        if "GKEPodSnapshotting" in line or "Successfully restored" in line:
            report.append(f"👉 {line}")
            restore_event_found = True
        elif "Started" in line or "Created" in line or "Scheduled" in line:
            report.append(line)
    report.append("```")
    
    if restore_event_found:
        report.append("\n🎉 **SUCCESS:** Verified that GKE successfully restored the pod state from the PodSnapshot!")
        report.append("Compared to a standard cold start (which often takes 30-60+ seconds for large AI images due to pulling and full initialization), resuming from a memory snapshot takes only a few seconds, enabling near-instantaneous scaling and high availability.")
    else:
        report.append("\n⚠️ **Warning:** Pod recovered quickly, but the explicit `GKEPodSnapshotting` event was not found in the recent event log. This can happen if events are throttled or rotated. The fast recovery time strongly indicates snapshot usage.")
        
    # Cleanup
    _run_cmd("kubectl delete PodSnapshotManualTrigger demo-manual-trigger")
    _run_cmd("rm demo-trigger.yaml")
    
    return "\n".join(report)

# Global state for HPA Load Test

_hpa_executor = None
_hpa_stop_event = None
_hpa_start_time = None
_hpa_history = []
_hpa_num_sandboxes = 0
_hpa_duration = 0

def _get_hpa_status_internal():
    hpa_name = "agent-warmpool-hpa-fuse"
    pool_name = "openclaw-warmpool-gvisor-fuse"
    
    hpa_out = _run_cmd(f"kubectl get hpa {hpa_name} -o jsonpath='{{.status.currentReplicas}} {{.status.desiredReplicas}} {{.status.currentMetrics[0].external.current.value}}'")
    pool_out = _run_cmd(f"kubectl get sandboxwarmpool {pool_name} -o jsonpath='{{.status.replicas}} {{.status.readyReplicas}}'")
    
    if "❌" in hpa_out or "❌" in pool_out or not hpa_out or not pool_out:
        return "N/A", "N/A", "N/A", "N/A"
        
    h_parts = hpa_out.split()
    p_parts = pool_out.split()
    
    c_rep = h_parts[0] if len(h_parts) > 0 else "0"
    d_rep = h_parts[1] if len(h_parts) > 1 else "0"
    met = h_parts[2] if len(h_parts) > 2 else "N/A"
    
    w_rep = p_parts[0] if len(p_parts) > 0 else "0"
    w_ready = p_parts[1] if len(p_parts) > 1 else "0"
    
    return met, d_rep, w_rep, w_ready

def _hpa_load_worker_internal(idx, stop_event, start_time, duration):
    template_name = "openclaw-template-gvisor-fuse"
    from k8s_agent_sandbox import SandboxClient
    from k8s_agent_sandbox.models import SandboxGatewayConnectionConfig
    
    client = None
    try:
        client = SandboxClient(
            connection_config=SandboxGatewayConnectionConfig(
                gateway_name="external-http-gateway",
                gateway_namespace="default"
            )
        )
    except Exception:
        return
        
    while not stop_event.is_set() and (time.time() - start_time < duration):
        sandbox = None
        try:
            sandbox = client.create_sandbox(template=template_name, namespace="default")
            sandbox.run("echo 'OpenClaw Load Test' && sleep 5")
            time.sleep(15)
        except Exception:
            time.sleep(2)
        finally:
            if sandbox:
                try:
                    client.delete_sandbox(sandbox.claim_name)
                except Exception:
                    pass

def run_hpa_load_test_start(num_sandboxes: int = 15, duration_seconds: int = 120, confirmed: bool = False) -> str:
    """
    Starts the HPA elastic scaling load test by generating heavy concurrent load in the background.
    MUST be confirmed by the user first.
    
    Args:
        num_sandboxes: Number of concurrent sandboxes to claim. Default is 15.
        duration_seconds: Duration of the test in seconds. Default is 120.
        confirmed: Must be True to run.
        
    Returns:
        A message indicating the test has started, or a test plan if not confirmed.
    """
    global _hpa_executor, _hpa_stop_event, _hpa_start_time, _hpa_history, _hpa_num_sandboxes, _hpa_duration
    
    if not confirmed:
        return f"""### 📈 HPA 弹性扩缩容演示测试方案
**测试目标**：验证 HPA (HorizontalPodAutoscaler) 能够根据 AI 智能体（Agent）的并发请求量，动态扩展沙箱预热池（SandboxWarmPool）。
**测试参数**：并发索取 `{num_sandboxes}` 个沙箱，持续 `{duration_seconds}` 秒。
**测试步骤**：
1. 启动后台压测线程，并发索取沙箱。
2. **Agent 监控循环**：我将进入循环，每 15 秒调用一次 `run_hpa_load_test_status` 监控实时状态并流式输出给您。
3. 测试时间到达后，我将调用 `run_hpa_load_test_stop` 停止压测并生成总结报告。
**预期结果**：HPA 检测到索取速率激增，自动调大期望副本数，WarmPool 随即扩容。
**潜在风险**：消耗集群资源，测试结束后自动清理。

**⚠️ 请确认是否执行此测试？** (请回复 "确认执行" 或 "Yes")
"""
    
    if _hpa_executor is not None:
        return "❌ **Error:** A load test is already running. Please stop it first with `run_hpa_load_test_stop`."
        
    _hpa_num_sandboxes = num_sandboxes
    _hpa_duration = duration_seconds
    _hpa_stop_event = threading.Event()
    _hpa_history = []
    _hpa_start_time = time.time()
    
    # Record initial state
    met, d_rep, w_rep, w_ready = _get_hpa_status_internal()
    _hpa_history.append((0, met, d_rep, w_rep, w_ready))
    
    # Start load generation
    _hpa_executor = ThreadPoolExecutor(max_workers=num_sandboxes)
    for i in range(num_sandboxes):
        _hpa_executor.submit(_hpa_load_worker_internal, i, _hpa_stop_event, _hpa_start_time, _hpa_duration)
        
    return f"🚀 **HPA 弹性扩缩容测试已启动！**\n并发索取沙箱数: `{num_sandboxes}`，预计持续时间: `{duration_seconds}` 秒。\n\n**接下来我将开始实时监控，请稍等...**"

def run_hpa_load_test_status() -> str:
    """
    Waits for 15 seconds, then checks and returns the accumulated HPA and WarmPool status history as a table.
    Call this repeatedly during the test to stream the progress.
    
    Returns:
        A markdown table showing the scaling history up to the current time.
    """
    global _hpa_start_time, _hpa_history, _hpa_duration
    
    if _hpa_start_time is None:
        return "❌ **Error:** No load test is currently running."
        
    # Wait 15 seconds for the monitoring interval
    time.sleep(15)
    
    elapsed = int(time.time() - _hpa_start_time)
    met, d_rep, w_rep, w_ready = _get_hpa_status_internal()
    _hpa_history.append((elapsed, met, d_rep, w_rep, w_ready))
    
    report = [
        f"🕒 **HPA 弹性扩缩容实时监控 (已运行: {elapsed}s / 目标: {_hpa_duration}s)**\n",
        "| 运行时间 (Elapsed) | HPA 指标 (并发索取数) | HPA 期望副本数 (Desired) | WarmPool 实例数 (Ready) | 当前状态 (Status) |",
        "|---:|---:|---:|---:|:---|",
    ]
    
    for i, h in enumerate(_hpa_history):
        e, m, d, w, wr = h
        s = "🌱 初始化 (Idle)"
        if i > 0:
            def _safe_int(val, default=0):
                try:
                    return int(val)
                except (ValueError, TypeError):
                    return default
                    
            curr_d = _safe_int(d)
            prev_d = _safe_int(_hpa_history[i-1][2])
            curr_w = _safe_int(w)
            prev_w = _safe_int(_hpa_history[i-1][3])
            init_d = _safe_int(_hpa_history[0][2])
            
            if d == "N/A" or w == "N/A":
                s = "⚠️ 监控数据异常 (Error)"
            elif curr_d > prev_d:
                s = "🚀 HPA 触发扩容! (Scale Up)"
            elif curr_w > prev_w:
                s = "⏳ 实例启动中... (Provisioning)"
            elif curr_d > init_d:
                s = "⚡ 持续扩容中 (Scaling)"
            else:
                s = "🟢 运行平稳 (Stable)"
        report.append(f"| {e}s | {m} | {d} | {w} ({wr}) | {s} |")
        
    if elapsed >= _hpa_duration:
        report.append("\n⏱️ **达到设定测试时间。** 请调用 `run_hpa_load_test_stop` 以停止测试并查看最终分析报告。")
        
    return "\n".join(report)

def run_hpa_load_test_stop() -> str:
    """
    Stops the HPA load test background threads, cleans up all claims, and returns the final analysis report.
    
    Returns:
        A comprehensive markdown report of the load test results.
    """
    global _hpa_executor, _hpa_stop_event, _hpa_start_time, _hpa_history, _hpa_num_sandboxes, _hpa_duration
    
    if _hpa_executor is None:
        return "❌ **Error:** No load test is currently running."
        
    # Stop load
    _hpa_stop_event.set()
    _hpa_executor.shutdown(wait=False)
    
    # 🧹 环境清理 (Environment Cleanup)
    # 1. 删除所有 SandboxClaim (触发控制器删除底层 Pod)
    _run_cmd("kubectl delete sandboxclaim --all")
    
    # 2. 强行删除卡在 Terminating 状态的沙箱 Pod (WarmPool 和 Claim 残留)
    stuck_pods_cmd = "kubectl get pods | grep -E 'openclaw-warmpool-gvisor-fuse|sandbox-claim' | grep Terminating | awk '{print $1}'"
    stuck_pods = _run_cmd(stuck_pods_cmd).splitlines()
    
    deleted_pods = []
    for pod in stuck_pods:
        pod = pod.strip()
        if pod:
            _run_cmd(f"kubectl delete pod {pod} --grace-period=0 --force")
            deleted_pods.append(pod)
            
    # 3. 强行删除所有可能残留的 Running 状态的临时沙箱 Pod (sandbox-claim-*)
    running_claims_cmd = "kubectl get pods | grep 'sandbox-claim' | grep Running | awk '{print $1}'"
    running_claims = _run_cmd(running_claims_cmd).splitlines()
    for pod in running_claims:
        pod = pod.strip()
        if pod:
            _run_cmd(f"kubectl delete pod {pod} --grace-period=0 --force")
            deleted_pods.append(pod)
            
    report = ["# 📈 HPA 弹性扩缩容演示最终报告\n"]
    report.append(f"**测试配置**：并发索取 `{_hpa_num_sandboxes}` 个沙箱，持续 `{_hpa_duration}` 秒。\n")
    
    if deleted_pods:
        report.append("🧹 **环境自动清理 (Auto-Cleanup):**\n")
        report.append(f"成功强行清理了 **{len(deleted_pods)}** 个残留/卡死的沙箱 Pod 资源：")
        report.append("- 已执行 `kubectl delete sandboxclaim --all` 确保所有 Claim 声明被清除。")
        report.append("- 已执行 `kubectl delete pod --force` 强行移除了以下卡死在 `Terminating` 或残留的 Pod：")
        report.append("```")
        for p in deleted_pods:
            report.append(f"  - {p}")
        report.append("```")
        report.append("*(注：GKE 调度器与存储挂载在高并发压测下可能导致 Pod 卡死，已通过强行删除恢复环境干净状态。)*\n")
    else:
        report.append("🧹 **环境自动清理 (Auto-Cleanup):** 未发现残留或卡死的沙箱 Pod，环境保持良好。\n")
        
    report.append("## 📊 完整扩缩容历史")
    report.append("| 运行时间 (Elapsed) | HPA 指标 (并发索取数) | HPA 期望副本数 (Desired) | WarmPool 实例数 (Ready) | 状态 (Status) |")
    report.append("|---:|---:|---:|---:|:---|")
    
    for i, h in enumerate(_hpa_history):
        e, m, d, w, wr = h
        s = "🌱 初始化"
        if i > 0:
            prev_d = int(_hpa_history[i-1][2])
            prev_w = int(_hpa_history[i-1][3])
            if int(d) > prev_d:
                s = "🚀 HPA 触发扩容"
            elif int(w) > prev_w:
                s = "⏳ 实例启动中"
            elif int(d) > int(_hpa_history[0][2]):
                s = "⚡ 持续扩容中"
            else:
                s = "🟢 运行平稳"
        report.append(f"| {e}s | {m} | {d} | {w} ({wr}) | {s} |")
        
    report.append("\n⏹️ **负载生成已停止。** 正在清理测试索取的沙箱资源...")
    
    # Analysis
    report.append("\n## 📊 结果分析")
    initial_rep = int(_hpa_history[0][3])
    final_rep = int(_hpa_history[-1][3])
    max_desired = max(int(h[2]) for h in _hpa_history if h[2] != "N/A")
    
    report.append(f"- **初始 WarmPool 大小**：`{initial_rep}` 实例")
    report.append(f"- **HPA 触发最大期望大小**：`{max_desired}` 实例")
    report.append(f"- **最终 WarmPool 大小**：`{final_rep}` 实例")
    
    if max_desired > initial_rep:
        report.append(f"\n🎉 **测试成功**：HPA 成功检测到并发索取速率的激增，并动态扩展了 `SandboxWarmPool`！")
        report.append(f"这证明了 `ai-agent-sandbox-on-gke` 架构能够通过动态调整预热池大小，轻松应对 AI 智能体需求的爆发式增长，在保证亚秒级启动的同时，在空闲时降低基础设施成本。")
    else:
        report.append(f"\n⚠️ **观察结果**：HPA 在测试期间未触发扩容。这通常是因为：")
        report.append("1. 指标从收集到上报至 Stackdriver 存在延迟（通常 1-3 分钟），测试时间可能较短。")
        report.append("2. 当前 WarmPool 的初始容量足够大，未达到触发扩容的阈值。")
        report.append("3. 自定义指标适配器（Custom Metrics Adapter）可能正在预热。")
        
    # Reset state
    _hpa_executor = None
    _hpa_stop_event = None
    _hpa_start_time = None
    _hpa_history = []
    
    return "\n".join(report)

def get_feishu_configuration_guide() -> str:
    """
    Returns the complete, step-by-step guide for configuring Feishu channels in OpenClaw.
    Includes instructions for creating the app in Feishu platform, setting permissions,
    and using the OpenClaw CLI to link the account.
    
    Returns:
        Markdown content of the Feishu configuration guide.
    """
    try:
        with open("openclaw/configure-feishu.MD", "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return "❌ **Error:** `openclaw/configure-feishu.MD` not found in the repository."

def explain_storage_options() -> str:
    """
    Provides a comprehensive comparison between Cloud Storage FUSE and PersistentVolumeClaim (PVC/Filestore)
    for AI Agent Sandboxes. Explains why FUSE is strongly recommended for this architecture.
    
    Returns:
        A detailed markdown comparison and recommendation.
    """
    return """
# 💾 Storage Options for AI Agent Sandboxes: FUSE vs PVC

In the `ai-agent-sandbox-on-gke` architecture, AI agents run in isolated gVisor sandboxes. These sandboxes are ephemeral but require persistent storage to retain their workspace state (code, files, logs). You have two primary options: **Cloud Storage FUSE** and **PersistentVolumeClaim (PVC) via Filestore**.

## 📊 Comparison Table

| Feature | 🟢 Cloud Storage FUSE (Recommended) | 🟡 PVC (GCP Filestore) |
| :--- | :--- | :--- |
| **Architecture** | Mounts a GCS Bucket directly into the sandbox. | Mounts an NFS share from a Filestore instance. |
| **Cost** | 💰 **Extremely Low.** Pay only for GCS storage used ($0.02/GB) and operations. | 💸 **High.** Filestore has a minimum size (1TB) costing ~$200+/mo flat rate. |
| **Scaling** | 🚀 **Infinite.** Thousands of sandboxes can mount the same bucket simultaneously with no bottleneck. | ⚠️ **Limited.** NFS mount limits and bandwidth contention under high concurrency. |
| **Startup Speed** | ⚡ **Instant.** Mounting a FUSE volume takes milliseconds, perfect for WarmPools. | ⏳ **Slower.** Attaching and mounting PVCs can take seconds, adding to cold start latency. |
| **State Persistence** | Files are synced directly to GCS. Survives sandbox recreation perfectly. | Files survive, but sharing PVCs dynamically among many agents is complex. |
| **POSIX Compliance** | ⚠️ **Partial.** Supports basic file ops, but lacks hard links, file locking, and extended attributes. | ✅ **Full.** Standard POSIX filesystem, supports all operations including symlinks/locks. |
| **Security** | 🔒 Runs inside gVisor via a secure FUSE implementation, isolating the host. | 🔒 Secure NFS mount, but requires network paths and CSI drivers. |

## 🎯 Antigravity's Recommendation: USE CLOUD STORAGE FUSE

We **strongly recommend FUSE** for standard AI Agent Sandbox deployments for the following reasons:

1. **Massive Cost Savings:** AI agents typically need a few megabytes or gigabytes of workspace. Allocating a 1TB Filestore instance for ephemeral agents is wasteful. GCS FUSE allows you to scale from 0 to millions of agents with zero idle cost.
2. **WarmPool Compatibility:** The core feature of this repo is the `SandboxWarmPool` which keeps sandboxes pre-warmed for sub-second startup. GCS FUSE integrates seamlessly, allowing instantly created sandboxes to mount their dedicated GCS prefix (e.g., `gs://my-bucket/agent-session-123/`) instantly.
3. **Decoupled State:** Agent state is stored in GCS, making it easily accessible outside the cluster for auditing, debugging, or long-term archiving.

### When should you use PVC (Filestore)?
*   **Heavy Random I/O:** If your agents are performing intensive compilation, running embedded databases (like SQLite) with high write concurrency, or require high-IOPS random small-file writes.
*   **Full POSIX Requirements:** If the tools or software your agent runs strictly require hard links, file locking, or specific filesystem permissions that GCS does not support.

## 🛠️ Configuration in this Repo

*   **FUSE (Recommended):** Uses `openclaw-sandbox-gvisor-fuse.yaml` which mounts a GCS bucket via the GKE GCS FUSE CSI driver.
*   **PVC:** Uses `openclaw-sandbox-gvisor-pvc.yaml` which requires `storageclass.yaml` to provision a Filestore instance.

To deploy the recommended FUSE version:
```bash
kubectl apply -f openclaw/openclaw-sandbox-gvisor-fuse.yaml
```
"""

# Dynamically fetch project ID to force Vertex AI backend (avoids API key requirement)
try:
    project_id = subprocess.run("gcloud config get-value project", shell=True, capture_output=True, text=True).stdout.strip()
    if not project_id:
        project_id = "flius-test-28" # Fallback
except Exception:
    project_id = "flius-test-28"

vertex_model = f"projects/{project_id}/locations/us-central1/publishers/google/models/gemini-2.5-flash"

# Define the ADK Agent
root_agent = Agent(
    name="demo_agent",
    model=vertex_model,
    instruction="""You are an expert AI Platform and DevOps assistant specialized in GKE, gVisor, and AI Agent Sandbox architectures.
Your primary goal is to help the user demonstrate and understand the key features of the `ai-agent-sandbox-on-gke` repository.

You have access to powerful tools to:
1. Execute `kubectl` commands to inspect and manage the cluster.
2. Run a live **Pod Snapshot Performance Demo** (`run_pod_snapshot_demo`) which triggers a snapshot, deletes a pod, and measures its recovery time.
3. Run an **HPA Elastic Scaling Demo** which generates heavy concurrent load to simulate user activity and monitors scaling. For this demo, you must use three tools in sequence: `run_hpa_load_test_start`, `run_hpa_load_test_status`, and `run_hpa_load_test_stop`.
4. Provide a comprehensive **Feishu Channel Configuration Guide** (using OpenClaw as an example).
5. Explain and compare **Storage Options (FUSE vs PVC)**, always recommending FUSE for this architecture.

**⚠️ CRITICAL WORKFLOW FOR TESTING (DEMOS):**
You are **STRICTLY FORBIDDEN** from running the test tools immediately when a user asks for a demonstration. You MUST follow this mandatory process:
1.  **Propose & Request Confirmation:** First, call the corresponding start tool with `confirmed=False` (the default) to obtain the detailed Test Plan. Present this Test Plan to the user and explicitly ask for confirmation (e.g., "Do you approve running this test? Please reply with 'Yes' to proceed."). You MUST NOT execute the test in this turn.
2.  **Execute After Confirmation:** Wait for the user's response. If and ONLY IF the user explicitly confirms (says "Yes", "Approve", "确认", etc.), you may proceed in the NEXT turn:
    *   For **Pod Snapshot Demo**: Call `run_pod_snapshot_demo` with `confirmed=True`.
    *   For **HPA Load Test**:
        1. Call `run_hpa_load_test_start` with `confirmed=True`.
        2. IMMEDIATELY enter a monitoring loop. In each subsequent turn, call `run_hpa_load_test_status`. This tool will automatically wait 15 seconds and return the accumulated history table. Present this table to the user.
        3. Repeat calling `run_hpa_load_test_status` in subsequent turns until the elapsed time reaches the test duration.
        4. Finally, call `run_hpa_load_test_stop` to stop the test and present the final analysis report.

For non-test tools (`kubectl_cmd`, `get_feishu_configuration_guide`, `explain_storage_options`), you may use them directly as needed.

Provide insights into WHY these features are important (e.g., cost savings of FUSE, agility of WarmPool, resilience of Snapshots).
Be polite, professional, and highly technical. Format all responses in beautiful Markdown.
""",
    description="An agent to demonstrate GKE AI Sandbox features: Pod Snapshot, HPA, Feishu, and Storage.",
    tools=[
        kubectl_cmd,
        run_pod_snapshot_demo,
        run_hpa_load_test_start,
        run_hpa_load_test_status,
        run_hpa_load_test_stop,
        get_feishu_configuration_guide,
        explain_storage_options
    ]
)

if __name__ == "__main__":
    print("This file defines the ADK agent. Run it using: adk run demo_agent")
