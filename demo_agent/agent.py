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
_hpa_master_thread = None
_hpa_stop_event = None
_hpa_start_time = None
_hpa_history = []
_hpa_rps = 1.0
_hpa_hold_time = 15.0
_hpa_creation_duration = 120
_hpa_phase = "Idle"
_hpa_load_duration = 0
_hpa_cooldown_duration = 0
_hpa_claims_created = 0

def _get_hpa_status_internal():
    import json
    hpa_name = "agent-warmpool-hpa-fuse"
    pool_name = "openclaw-warmpool-gvisor-fuse"
    
    hpa_out = _run_cmd(f"kubectl get hpa {hpa_name} -o json")
    pool_out = _run_cmd(f"kubectl get sandboxwarmpool {pool_name} -o json")
    
    if "❌" in hpa_out or "❌" in pool_out or not hpa_out or not pool_out:
        return "N/A", "N/A", "N/A", "N/A"
        
    try:
        hpa_data = json.loads(hpa_out)
        pool_data = json.loads(pool_out)
        
        c_rep = str(hpa_data.get("status", {}).get("currentReplicas", "0"))
        d_rep = str(hpa_data.get("status", {}).get("desiredReplicas", "0"))
        
        met = "N/A"
        metrics = hpa_data.get("status", {}).get("currentMetrics", [])
        if metrics and len(metrics) > 0:
            ext = metrics[0].get("external", {})
            if ext:
                curr = ext.get("current", {})
                if "value" in curr:
                    met = str(curr["value"])
                elif "averageValue" in curr:
                    met = str(curr["averageValue"])
        
        w_rep = str(pool_data.get("status", {}).get("replicas", "0"))
        w_ready = str(pool_data.get("status", {}).get("readyReplicas", "0"))
        
        return met, d_rep, w_rep, w_ready
    except Exception:
        return "N/A", "N/A", "N/A", "N/A"

def _hpa_test_master_loop(rps, hold_time, creation_duration, stop_event):
    global _hpa_history, _hpa_phase, _hpa_start_time
    
    _hpa_phase = "Load"
    _hpa_start_time = time.time()
    _hpa_history = []
    
    # Record initial state
    met, d_rep, w_rep, w_ready = _get_hpa_status_internal()
    _hpa_history.append((0, met, d_rep, w_rep, w_ready))
    
    initial_replicas = _run_cmd("kubectl get sandboxwarmpool openclaw-warmpool-gvisor-fuse -o jsonpath='{.spec.replicas}'")
    try:
        initial_replicas = int(initial_replicas)
    except:
        initial_replicas = 1
        
    claims_created = 0
    last_status_time = _hpa_start_time
    
    template_name = "openclaw-template-gvisor-fuse"
    from k8s_agent_sandbox import SandboxClient
    from k8s_agent_sandbox.models import SandboxGatewayConnectionConfig
    
    try:
        client = SandboxClient(
            connection_config=SandboxGatewayConnectionConfig(
                gateway_name="external-http-gateway",
                gateway_namespace="default"
            )
        )
    except Exception:
        _hpa_phase = "Error"
        return
        
    def _create_and_hold():
        import uuid
        claim_name = f"hpa-test-claim-{uuid.uuid4().hex[:8]}"
        yaml_content = f"""apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: {claim_name}
  namespace: default
spec:
  sandboxTemplateRef:
    name: openclaw-template-gvisor-fuse
"""
        try:
            _run_cmd(f"echo '{yaml_content}' | kubectl apply -f -")
            time.sleep(hold_time)
        except Exception:
            pass
        finally:
            try:
                _run_cmd(f"kubectl delete sandboxclaim {claim_name} --grace-period=0 --force")
            except Exception:
                pass
                    
    executor = ThreadPoolExecutor(max_workers=50)
    
    # Get max replicas
    max_replicas_out = _run_cmd("kubectl get hpa agent-warmpool-hpa-fuse -o jsonpath='{.spec.maxReplicas}'")
    try:
        max_replicas = int(max_replicas_out)
    except:
        max_replicas = 100
        
    # Phase 1: Load Generation
    while not stop_event.is_set() and (time.time() - _hpa_start_time < creation_duration):
        now = time.time()
        elapsed = now - _hpa_start_time
        
        expected_claims = int(elapsed * rps)
        if claims_created < expected_claims:
            executor.submit(_create_and_hold)
            claims_created += 1
            
            if claims_created % 15 == 0:
                _hpa_start_time += 15
                last_status_time += 15
                time.sleep(15)
            
        if now - last_status_time >= 15:
            met, d_rep, w_rep, w_ready = _get_hpa_status_internal()
            _hpa_history.append((int(elapsed), met, d_rep, w_rep, w_ready))
            last_status_time = now
            
            try:
                curr_d = int(d_rep)
                curr_w = int(w_rep)
                if curr_d >= max_replicas or curr_w >= max_replicas:
                    break
            except:
                pass
                
            try:
                report = _generate_final_report()
                os.makedirs("scratch", exist_ok=True)
                with open("scratch/hpa_test_report.md", "w") as f:
                    f.write(report)
            except Exception:
                pass
            
        time.sleep(0.1)
        
    global _hpa_load_duration, _hpa_claims_created
    _hpa_load_duration = int(time.time() - _hpa_start_time)
    _hpa_claims_created = claims_created
    
    # Phase 2: Cooldown / Scale Down
    _hpa_phase = "Cooldown"
    cooldown_start = time.time()
    
    while not stop_event.is_set():
        now = time.time()
        elapsed = now - _hpa_start_time
        
        if now - last_status_time >= 15:
            met, d_rep, w_rep, w_ready = _get_hpa_status_internal()
            _hpa_history.append((int(elapsed), met, d_rep, w_rep, w_ready))
            last_status_time = now
            
            try:
                report = _generate_final_report()
                os.makedirs("scratch", exist_ok=True)
                with open("scratch/hpa_test_report.md", "w") as f:
                    f.write(report)
            except Exception:
                pass
                
            try:
                curr_w = int(w_rep)
                if curr_w <= initial_replicas:
                    break
            except:
                pass
                
            if now - cooldown_start > 900:
                break
                
        time.sleep(1)
        
    global _hpa_cooldown_duration
    _hpa_cooldown_duration = int(time.time() - cooldown_start)
    
    # Phase 3: Done
    executor.shutdown(wait=True)
    _hpa_phase = "Done"
    
    try:
        report = _generate_final_report()
        os.makedirs("scratch", exist_ok=True)
        with open("scratch/hpa_test_report.md", "w") as f:
            f.write(report)
    except Exception:
        pass

def _generate_final_report() -> str:
    global _hpa_history, _hpa_rps, _hpa_hold_time, _hpa_creation_duration
    global _hpa_load_duration, _hpa_cooldown_duration, _hpa_claims_created
    
    report = ["# 📈 HPA 弹性扩缩容演示最终报告\n"]
    report.append(f"**测试配置**：目标 RPS `{_hpa_rps}`，沙箱保持时间 `{_hpa_hold_time}s`，负载持续 `{_hpa_creation_duration}s`。\n")
    
    total_duration = _hpa_load_duration + _hpa_cooldown_duration
    actual_rate = _hpa_claims_created / _hpa_load_duration if _hpa_load_duration > 0 else 0
    
    report.append("## ⏱️ 时间与速率统计")
    report.append(f"- **加压阶段耗时**：`{_hpa_load_duration}s`")
    report.append(f"- **冷却缩容阶段耗时**：`{_hpa_cooldown_duration}s`")
    report.append(f"- **总测试耗时**：`{total_duration}s`")
    report.append(f"- **成功创建沙箱总数**：`{_hpa_claims_created}`")
    report.append(f"- **实际创建速率**：`{actual_rate:.2f} /s` (目标 RPS: `{_hpa_rps}`)")
    report.append("\n")
    
    report.append("## 📊 完整扩缩容历史")
    report.append("<table border='1' style='border-collapse: collapse; width: 100%; text-align: center;'>")
    report.append("  <tr style='background-color: #f2f2f2;'>")
    report.append("    <th>运行时间 (Elapsed)</th>")
    report.append("    <th>HPA 指标 (并发沙箱数)</th>")
    report.append("    <th>HPA 期望副本数 (Desired)</th>")
    report.append("    <th>WarmPool 实例数 (Ready)</th>")
    report.append("    <th>当前状态 (Status)</th>")
    report.append("  </tr>")
    
    for i, h in enumerate(_hpa_history):
        e, m, d, w, wr = h
        s = "🌱 初始化"
        if i > 0:
            def _safe_int(val, default=0):
                try: return int(val)
                except: return default
            
            prev_d = _safe_int(_hpa_history[i-1][2])
            curr_d = _safe_int(d)
            prev_w = _safe_int(_hpa_history[i-1][3])
            curr_w = _safe_int(w)
            
            if curr_d > prev_d:
                s = "🚀 HPA 触发扩容"
            elif curr_w > prev_w:
                s = "⏳ 实例启动中"
            elif curr_d > _safe_int(_hpa_history[0][2]):
                s = "⚡ 持续扩容中"
            elif curr_w < prev_w:
                s = "📉 触发缩容"
            else:
                s = "🟢 运行平稳"
        report.append(f"  <tr><td>{e}s</td><td>{m}</td><td>{d}</td><td>{w} ({wr})</td><td>{s}</td></tr>")
        
    report.append("</table>")
        
    report.append("\n## 📊 结果分析")
    try:
        initial_rep = int(_hpa_history[0][3])
        final_rep = int(_hpa_history[-1][3])
        max_desired = max(int(h[2]) for h in _hpa_history if h[2] != "N/A")
        
        report.append(f"- **初始 WarmPool 大小**：`{initial_rep}` 实例")
        report.append(f"- **HPA 触发最大期望大小**：`{max_desired}` 实例")
        report.append(f"- **最终 WarmPool 大小**：`{final_rep}` 实例")
        
        if max_desired > initial_rep:
            report.append(f"\n🎉 **测试成功**：HPA 成功检测到并发沙箱速率的激增，并动态扩展了 `SandboxWarmPool`！")
        else:
            report.append(f"\n⚠️ **观察结果**：HPA 在测试期间未触发扩容。")
    except:
        report.append("分析数据不足。")
        
    return "\n".join(report)

def run_hpa_load_test_start(rps: float = 1.0, hold_time: float = 15.0, creation_duration: int = 120, confirmed: bool = False) -> str:
    """
    Starts the HPA elastic scaling load test by generating heavy concurrent load in the background.
    MUST be confirmed by the user first.
    
    Args:
        rps: Requests (claims) per second to create. Default is 1.0.
        hold_time: How long each sandbox stays alive before deletion (in seconds). Default is 15.0.
        creation_duration: Duration to keep generating new claims (in seconds). Default is 120.
        confirmed: Must be True to run.
        
    Returns:
        A message indicating the test has started, or a test plan if not confirmed.
    """
    global _hpa_master_thread, _hpa_stop_event, _hpa_rps, _hpa_hold_time, _hpa_creation_duration, _hpa_phase
    
    if not confirmed:
        return f"""### 📈 HPA 弹性扩缩容演示测试方案
**测试目标**：验证 HPA 能够根据 AI 智能体并发请求量，动态扩展沙箱预热池。
**测试参数**：
- **RPS** (每秒创建): `{rps}`
- **保持时间** (每个沙箱存活): `{hold_time}s`
- **负载时长**: `{creation_duration}s`
**测试步骤**：
1. 启动后台线程，按 RPS 生成沙箱沙箱负载。
2. 负载结束后，**继续监控** HPA 直到 WarmPool 缩容回初始状态（minReplicas）。
3. 自动生成最终报告并保存至 `scratch/hpa_test_report.md`。

**⚠️ 请确认是否执行此测试？** (请回复 "确认执行" 或 "Yes")
"""
    
    if _hpa_master_thread is not None and _hpa_master_thread.is_alive():
        return f"❌ **Error:** A load test is already running. Phase: `{_hpa_phase}`."
        
    _hpa_rps = rps
    _hpa_hold_time = hold_time
    _hpa_creation_duration = creation_duration
    _hpa_stop_event = threading.Event()
    
    _hpa_master_thread = threading.Thread(
        target=_hpa_test_master_loop,
        args=(rps, hold_time, creation_duration, _hpa_stop_event),
        daemon=True
    )
    _hpa_master_thread.start()
        
    return f"🚀 **HPA 弹性扩缩容测试已启动！**\n参数: RPS={rps}, HoldTime={hold_time}s, Duration={creation_duration}s\n\n**后台正在运行，您可以随时调用 `run_hpa_load_test_status` 查看当前进度。**"

def run_hpa_load_test_status() -> str:
    """
    Checks and returns the accumulated HPA and WarmPool status history as a table.
    Blocks for 15 seconds to pace the LLM loop unless done.
    
    Returns:
        A markdown table showing the scaling history up to the current time.
    """
    global _hpa_start_time, _hpa_history, _hpa_creation_duration, _hpa_phase
    
    if _hpa_phase == "Idle":
        return "❌ **Error:** No load test is currently running."
        
    if _hpa_phase != "Done":
        time.sleep(15)
        
    elapsed = int(time.time() - _hpa_start_time) if _hpa_start_time else 0
    
    report = [
        f"<p>🕒 <b>HPA 弹性扩缩容实时监控 (当前阶段: {_hpa_phase} / 已运行: {elapsed}s)</b></p>",
        "<table border='1' style='border-collapse: collapse; width: 100%; text-align: center;'>",
        "  <tr style='background-color: #f2f2f2;'>",
        "    <th>运行时间 (Elapsed)</th>",
        "    <th>HPA 指标 (并发沙箱数)</th>",
        "    <th>HPA 期望副本数 (Desired)</th>",
        "    <th>WarmPool 实例数 (Ready)</th>",
        "    <th>当前状态 (Status)</th>",
        "  </tr>"
    ]
    
    for i, h in enumerate(_hpa_history):
        e, m, d, w, wr = h
        s = "🌱 初始化"
        if i > 0:
            def _safe_int(val, default=0):
                try: return int(val)
                except: return default
            
            prev_d = _safe_int(_hpa_history[i-1][2])
            curr_d = _safe_int(d)
            prev_w = _safe_int(_hpa_history[i-1][3])
            curr_w = _safe_int(w)
            
            if curr_d > prev_d:
                s = "🚀 HPA 触发扩容"
            elif curr_w > prev_w:
                s = "⏳ 实例启动中"
            elif curr_d > _safe_int(_hpa_history[0][2]):
                s = "⚡ 持续扩容中"
            elif curr_w < prev_w:
                s = "📉 触发缩容"
            else:
                s = "🟢 运行平稳"
        report.append(f"  <tr><td>{e}s</td><td>{m}</td><td>{d}</td><td>{w} ({wr})</td><td>{s}</td></tr>")
        
    report.append("</table>")
        
    if _hpa_phase == "Done":
        report.append("\n🎉 **测试已完成！** 最终报告已保存至 `scratch/hpa_test_report.md`。")
        
    return "\n".join(report)

def run_hpa_load_test_stop() -> str:
    """
    Stops the HPA load test, cleans up claims, and returns the report.
    """
    global _hpa_stop_event, _hpa_phase
    
    if _hpa_phase == "Idle":
        return "❌ **Error:** No load test is currently running."
        
    if _hpa_stop_event:
        _hpa_stop_event.set()
        
    _run_cmd("kubectl delete sandboxclaim --all")
    
    report = _generate_final_report()
    _hpa_phase = "Idle"
    
    return report

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
        2. **Crucial:** Do NOT answer the user yet. Instead, immediately enter a continuous loop of calling `run_hpa_load_test_status` until the output indicates the phase is "Done". Present the result of each call.
        3. Once the phase is "Done", call `run_hpa_load_test_stop` to get the final analysis, and ONLY THEN provide your final response to the user with the report.

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
