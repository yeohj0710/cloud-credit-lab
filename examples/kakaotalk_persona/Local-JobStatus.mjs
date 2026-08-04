import { listJobs } from "../../lib/jobs.js";

const jobId = String(process.argv[2] || "");
if (!jobId) throw new Error("job_id_required");
const job = (await listJobs()).find((item) => item.id === jobId);
if (!job) throw new Error("job_not_found");

console.log(JSON.stringify({
  id: job.id,
  provider: job.provider,
  status: job.status,
  stage: job.stage || null,
  billing_started_at: job.billing_started_at || null,
  instance_id: job.instance_id || null,
  instance_deleted_at: job.instance_deleted_at || null,
  public_ip_id: job.public_ip_id || null,
  public_ip_removed_at: job.public_ip_removed_at || null,
  cleanup_error: job.cleanup_error || null,
  error: job.error || null,
}));
