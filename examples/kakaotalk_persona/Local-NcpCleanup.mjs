import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteNcpGpu } from "../../lib/ncp-gpu.js";
import { gpuCost } from "../../lib/gpu-resources.js";
import { listJobs, updateJob } from "../../lib/jobs.js";
import { deleteObject, downloadObject } from "../../lib/ncp-storage.js";
import { addUsage, stopStorage } from "../../lib/usage.js";

const jobId = String(process.argv[2] || "");
const artifactRoot = String(process.argv[3] || "");
if (!jobId) throw new Error("job_id_required");

const job = (await listJobs()).find((item) => item.id === jobId);
if (!job) throw new Error("job_not_found");
if (job.provider !== "naver") throw new Error("naver_job_required");

const alreadyClean = Boolean(job.instance_deleted_at && !job.cleanup_error);
const cleanup = alreadyClean ? { publicIpRemoved: Boolean(job.public_ip_removed_at) } : await deleteNcpGpu(job);
let amount = job.usage_amount || 0;
let seconds = job.usage_seconds || 0;
let gpu = job.usage_gpu_amount || 0;
let disk = job.usage_disk_amount || 0;
let publicIp = job.usage_public_ip_amount || 0;
let usageRecordedAt = job.usage_recorded_at;
if (job.billing_started_at && !usageRecordedAt) {
  ({ amount, seconds, gpu, disk, publicIp } = gpuCost(job));
  usageRecordedAt = new Date().toISOString();
  await addUsage({
    provider: "naver",
    category: "gpu",
    action: ["completed", "failed", "cancelled"].includes(job.status) ? job.status : "local_deadline_cleanup",
    label: `${job.flavor_name || "GPU"} - ${job.key}`,
    amount,
    meta: { job_id: job.id, seconds, gpu, disk, public_ip: publicIp },
  });
}

const updated = alreadyClean ? job : await updateJob(job.id, {
  status: ["completed", "failed", "cancelled"].includes(job.status) ? job.status : "failed",
  error: ["completed", "failed", "cancelled"].includes(job.status) ? job.error : "local_runtime_deadline_reached",
  instance_deleted_at: new Date().toISOString(),
  public_ip_removed_at: cleanup.publicIpRemoved ? new Date().toISOString() : job.public_ip_removed_at,
  cleanup_error: undefined,
  usage_amount: amount,
  usage_gpu_amount: gpu,
  usage_disk_amount: disk,
  usage_public_ip_amount: publicIp,
  usage_seconds: seconds,
  usage_recorded_at: usageRecordedAt,
});

if (artifactRoot) {
  const jobDirectory = join(artifactRoot, job.id);
  await mkdir(jobDirectory, { recursive: true });
  for (const [key, filename] of [[job.result_key, "result.tar.gz"], [job.log_key, "run.log"]]) {
    if (!key) continue;
    try {
      const object = await downloadObject(job.bucket, key);
      await writeFile(join(jobDirectory, filename), object.body);
    } catch (error) {
      if (!/404|NoSuchKey/i.test(String(error.message))) throw error;
    }
  }
  const disposableKeys = [job.code_key, job.data_key, job.result_key, job.log_key, job.preview_key, job.manifest_key]
    .filter(Boolean).filter((key, index, values) => values.indexOf(key) === index);
  for (const key of disposableKeys) {
    try {
      await deleteObject(job.bucket, key);
      await stopStorage("naver", job.bucket, key);
    } catch (error) {
      if (!/404|NoSuchKey/i.test(String(error.message))) throw error;
    }
  }
  await writeFile(join(jobDirectory, "job.json"), JSON.stringify({
    job_id: updated.id,
    provider: updated.provider,
    status: updated.status,
    stage: updated.stage || null,
    actual_cost_krw: updated.usage_amount,
    usage_seconds: updated.usage_seconds,
    instance_deleted_at: updated.instance_deleted_at,
    public_ip_removed_at: updated.public_ip_removed_at || null,
    cleanup_error: updated.cleanup_error || null,
    error: updated.error || null,
  }, null, 2));
}

console.log(JSON.stringify({
  job_id: updated.id,
  status: updated.status,
  amount: updated.usage_amount,
  seconds: updated.usage_seconds,
  instance_deleted_at: updated.instance_deleted_at,
  cleanup_error: updated.cleanup_error || null,
  already_clean: alreadyClean,
}));
