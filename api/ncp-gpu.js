import { isAuthorized, isExecutionPassword } from "../lib/auth.js";
import { customWorkerScript } from "./cloud.js";
import { bootstrapNcpGpu, createNcpGpu, deleteNcpGpu, isNcpGpuQuotaError, ncpGpuReadiness, NCP_BLOCK_STORAGE_GIB_HOUR } from "../lib/ncp-gpu.js";
import { listJobs, updateJob } from "../lib/jobs.js";
import { estimateProviderGpu } from "../lib/usage.js";
import { assertActiveGpuJobLimit, assertProviderCanSpend } from "../lib/spend-guard.js";
import { assertHighValueCloudGpu } from "../lib/gpu-policy.js";

export default async function handler(request, response) {
  if (!await isAuthorized(new Request("https://cloud-gpu-runner/api/ncp-gpu", { headers: { cookie: request.headers.cookie || "" } }))) return response.status(401).json({ error: "unauthorized" });
  try {
    if (request.method === "GET") return response.json(await ncpGpuReadiness(String(request.query?.region || "KR")));
    if (request.method !== "POST") return response.status(405).json({ error: "method_not_allowed" });
    if (String(request.query?.action || "") === "bootstrap") return response.json(await bootstrapNcpGpu("KR"));
    const value = request.body || {};
    if (!isExecutionPassword(value.execution_password)) return response.status(403).json({ error: "execution_password_invalid" });
    const jobs = await listJobs();
    let job = jobs.find((item) => item.id === String(value.job_id || ""));
    if (!job) return response.status(404).json({ error: "job_not_found" });
    if (job.status !== "queued") return response.status(409).json({ error: "job_not_queued" });
    const maxMinutes = Math.min(1440, Math.max(15, Number(value.max_minutes) || 60));
    assertHighValueCloudGpu("naver", String(value.spec_code || ""));
    assertActiveGpuJobLimit(jobs, job.id, Math.min(2, Math.max(1, Number(value.parallel_job_limit) || 1)));
    await assertProviderCanSpend("naver", estimateProviderGpu("naver", String(value.spec_code || ""), maxMinutes, 50).total);
    job = await updateJob(job.id, { status: "provisioning", provider: "naver", provisioning_nonce: crypto.randomUUID() });
    const requestHost = String(request.headers.host || "").toLowerCase();
    const baseUrl = /^[a-z0-9.-]+\.vercel\.app$/.test(requestHost) ? `https://${requestHost}` : "https://cloud-gpu-runner.vercel.app";
    const script = customWorkerScript({ ...job, max_minutes: maxMinutes }, baseUrl);
    let created;
    try { created = await createNcpGpu(job, {
      region_code: "KR", spec_code: String(value.spec_code || ""), vpc_no: String(value.vpc_no || ""),
      subnet_no: String(value.subnet_no || ""), login_key_name: String(value.login_key_name || ""), acg_no: String(value.acg_no || ""),
    }, script); }
    catch (error) {
      if (isNcpGpuQuotaError(error)) {
        await updateJob(job.id, { status: "queued", provider: undefined, error: undefined, last_provider_error: "naver_gpu_quota_unavailable" }).catch(() => {});
        throw new Error("naver_gpu_quota_unavailable");
      }
      await updateJob(job.id, { status: "failed", error: String(error.message).slice(0, 500) }).catch(() => {}); throw error;
    }
    const instance = created.instance;
    let updated;
    const resourceJob = { ...job, provider: "naver", instance_id: instance.serverInstanceNo, init_script_no: created.init_script_no, region_code: instance.regionCode || "KR", public_ip_id: instance.publicIpInstanceNo || undefined, public_ip_address: instance.publicIp || undefined };
    try {
      updated = await updateJob(job.id, {
        ...resourceJob, status: "provisioning",
        max_minutes: maxMinutes, volume_gb: Math.max(50, Math.round(Number(instance.baseBlockStorageSize || 0) / 1073741824) || 50), flavor_name: created.spec.serverSpecCode,
        hourly_rate: created.spec.hourly_rate, disk_gib_hour_rate: NCP_BLOCK_STORAGE_GIB_HOUR, billing_started_at: new Date().toISOString(),
      });
    } catch (error) {
      await deleteNcpGpu(resourceJob).catch(() => {});
      throw error;
    }
    return response.status(201).json({ ok: true, job: updated, instance: { serverInstanceNo: instance.serverInstanceNo, status: instance.serverInstanceStatusName } });
  } catch (error) {
    return response.status(502).json({ error: error instanceof Error ? error.message : "ncp_gpu_request_failed" });
  }
}
