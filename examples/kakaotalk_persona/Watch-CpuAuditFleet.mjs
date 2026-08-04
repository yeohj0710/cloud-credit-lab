import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deleteNcpGpu } from "../../lib/ncp-gpu.js";
import { downloadObject, deleteObject } from "../../lib/ncp-storage.js";
import { addUsage } from "../../lib/usage.js";

const statePath = String(process.argv[2] || "");
const artifactRoot = String(process.argv[3] || "");
if (!statePath || !artifactRoot) throw new Error("state_and_artifact_paths_required");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let state = JSON.parse(await readFile(statePath, "utf8"));
const remainingMs = Math.max(0, state.cutoff_epoch * 1000 - Date.now());
if (remainingMs) await wait(remainingMs);

const destination = join(artifactRoot, state.fleet_id);
await mkdir(destination, { recursive: true });
for (const entry of state.entries.filter((item) => item.instance_id)) {
  const job = {
    provider: "naver", instance_id: entry.instance_id, init_script_no: entry.init_script_no,
    region_code: "KR", billing_started_at: entry.billing_started_at,
  };
  let cleanupError = null;
  try { await deleteNcpGpu(job); } catch (error) { cleanupError = String(error.message).slice(0, 300); }
  const endedAt = new Date().toISOString();
  const seconds = Math.max(0, (Date.now() - new Date(entry.billing_started_at).getTime()) / 1000);
  const amount = seconds / 3600 * (state.hourly_rate + state.volume_gb * state.disk_gib_hour_rate + state.public_ip_hourly_rate);
  await addUsage({ provider: "naver", category: "compute", action: cleanupError ? "cleanup_failed" : "completed", label: `Private embedding audit shard ${entry.shard}`, amount, meta: { fleet_id: state.fleet_id, shard: entry.shard, seconds } });
  let artifactReady = false;
  try {
    const object = await downloadObject(state.bucket, entry.result_key);
    await writeFile(join(destination, `shard-${entry.shard}.npz`), object.body);
    artifactReady = true;
    await deleteObject(state.bucket, entry.result_key);
  } catch (error) {
    if (!/404|NoSuchKey/i.test(String(error.message))) cleanupError ||= String(error.message).slice(0, 300);
  }
  entry.status = cleanupError ? "cleanup_failed" : "completed";
  entry.ended_at = endedAt;
  entry.usage_seconds = seconds;
  entry.usage_amount = amount;
  entry.artifact_ready = artifactReady;
  entry.cleanup_error = cleanupError;
  await writeFile(statePath, JSON.stringify(state, null, 2));
}
state.status = state.entries.some((entry) => entry.cleanup_error) ? "cleanup_failed" : "completed";
state.completed_at = new Date().toISOString();
await writeFile(statePath, JSON.stringify(state, null, 2));
await writeFile(join(destination, "fleet.json"), JSON.stringify({
  fleet_id: state.fleet_id, status: state.status, server_spec_code: state.server_spec_code,
  launched: state.launched, cutoff_epoch: state.cutoff_epoch,
  total_usage_amount: state.entries.reduce((sum, entry) => sum + Number(entry.usage_amount || 0), 0),
  artifacts_ready: state.entries.filter((entry) => entry.artifact_ready).length,
  cleanup_errors: state.entries.filter((entry) => entry.cleanup_error).length,
}, null, 2));
console.log(JSON.stringify({ fleet_id: state.fleet_id, status: state.status, launched: state.launched }));
