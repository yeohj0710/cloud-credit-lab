import { isAuthorized } from "../lib/auth.js";
import { createJob, deleteJob, listJobs, updateJob } from "../lib/jobs.js";
import { deleteObject, downloadObject, listObjects, presignObject } from "../lib/ncp-storage.js";
import { addUsage } from "../lib/usage.js";
import { deleteGpuResources, gpuCost } from "../lib/gpu-resources.js";
import { getModel, listModels, registerModel } from "../lib/models.js";

export default async function handler(request, response) {
  if (!await isAuthorized(new Request("https://work-memory/api/jobs", { headers: { cookie: request.headers.cookie || "" } }))) return response.status(401).json({ error: "unauthorized" });
  try {
    const action = String(request.query?.action || "");
    if (request.method === "GET" && action === "log-text") {
      const job = (await listJobs()).find((item) => item.id === String(request.query?.id || ""));
      if (!job?.log_key) return response.status(404).json({ error: "log_not_found" });
      const result = await downloadObject(job.bucket, job.log_key);
      return response.json({ ok: true, text: Buffer.from(result.body).toString("utf8").slice(-500000) });
    }
    if (request.method === "GET" && ["result", "log"].includes(action)) {
      const job = (await listJobs()).find((item) => item.id === String(request.query?.id || ""));
      const isLog = action === "log", key = isLog ? job?.log_key : job?.result_key;
      if (!key) return response.status(404).json({ error: isLog ? "log_not_found" : "result_not_found" });
      const result = await downloadObject(job.bucket, key);
      await addUsage({ provider: "naver", category: "storage_request", action: "download", label: key, amount: 0.0004, meta: { job_id: job.id } });
      response.setHeader("content-type", isLog ? "text/plain; charset=utf-8" : job.type === "custom-gpu" ? "application/gzip" : "application/json; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="${job.id}.${isLog ? "log.txt" : job.type === "custom-gpu" ? "tar.gz" : "json"}"`);
      return response.status(200).send(result.body);
    }
    if (request.method === "GET" && action === "result-url") {
      const job = (await listJobs()).find((item) => item.id === String(request.query?.id || ""));
      if (!job?.result_key) return response.status(404).json({ error: "result_not_found" });
      return response.json({ ok: true, url: presignObject(job.bucket, job.result_key, "GET", 3600) });
    }
    if (request.method === "GET" && action === "media-url") {
      const job = (await listJobs()).find((item) => item.id === String(request.query?.id || ""));
      if (!job) return response.status(404).json({ error: "job_not_found" });
      return response.json({ ok: true, url: presignObject(job.bucket, job.key, "GET", 3600), name: job.key.split("/").pop() });
    }
    if (request.method === "GET" && action === "preview-url") {
      const job = (await listJobs()).find((item) => item.id === String(request.query?.id || ""));
      if (!job?.preview_key) return response.status(404).json({ error: "preview_not_found" });
      const objects = await listObjects(job.bucket);
      if (!objects.some((item) => item.key === job.preview_key)) return response.status(404).json({ error: "preview_not_found" });
      return response.json({ ok: true, url: presignObject(job.bucket, job.preview_key, "GET", 3600) });
    }
    if (request.method === "GET") return response.json({ ok: true, items: (await listJobs()).slice().reverse() });

    if (request.method === "POST" && action === "cancel") {
      const id = String(request.body?.id || ""), job = (await listJobs()).find((item) => item.id === id);
      if (!job) return response.status(404).json({ error: "job_not_found" });
      let cleanup = { publicIpRemoved: false };
      if (job.instance_id) cleanup = await deleteGpuResources(job);
      let amount = job.usage_amount || 0, seconds = job.usage_seconds || 0, gpu = job.usage_gpu_amount || 0, disk = job.usage_disk_amount || 0, publicIp = job.usage_public_ip_amount || 0;
      if (job.billing_started_at && !job.usage_recorded_at) {
        ({ amount, seconds, gpu, disk, publicIp } = gpuCost(job));
        await addUsage({ provider: job.provider || "kakao", category: "gpu", action: "cancelled", label: `${job.flavor_name || "GPU"} · ${job.key}`, amount, meta: { job_id: id, seconds, hourly_rate: job.hourly_rate, volume_gb: job.volume_gb, gpu, disk, public_ip: publicIp } });
      }
      let updated = await updateJob(id, { status: "cancelled", cancelled_at: new Date().toISOString(), instance_deleted_at: job.instance_id ? new Date().toISOString() : undefined, public_ip_removed_at: cleanup.publicIpRemoved ? new Date().toISOString() : undefined, usage_amount: amount, usage_gpu_amount: gpu, usage_disk_amount: disk, usage_public_ip_amount: publicIp, usage_seconds: seconds, usage_recorded_at: job.usage_recorded_at || new Date().toISOString() });
      try {
        const objects = await listObjects(updated.bucket), artifactReady = objects.some((item) => item.key === updated.result_key);
        const model = artifactReady ? await registerModel(updated, { allowPartial: true }) : null;
        if (model) updated = await updateJob(id, { registered_model_id: model.id, model_version: model.version });
      } catch (error) { updated = await updateJob(id, { model_registry_error: String(error.message).slice(0, 300) }); }
      return response.json({ ok: true, job: updated });
    }
    if (request.method === "POST" && action === "retry") {
      const id = String(request.body?.id || ""), job = (await listJobs()).find((item) => item.id === id);
      if (!job) return response.status(404).json({ error: "job_not_found" });
      return response.json({ ok: true, job: await updateJob(id, { status: "queued", error: undefined, cleanup_error: undefined, instance_id: undefined }) });
    }
    if (request.method === "POST") {
      const bucket = String(request.body?.bucket || "");
      if (!bucket) return response.status(400).json({ error: "input_required" });
      const objects = await listObjects(bucket);
      if (request.body?.type === "custom-gpu") {
        const codeKey = String(request.body.code_key || ""), dataKey = String(request.body.data_key || ""), modelKey = String(request.body.model_key || "");
        if (!objects.some((item) => item.key === codeKey) || (dataKey && !objects.some((item) => item.key === dataKey)) || (modelKey && !objects.some((item) => item.key === modelKey))) return response.status(404).json({ error: "input_not_found" });
        if (modelKey) {
          const model = await getModel(request.body.model_id);
          if (!model || model.bucket !== bucket || model.artifact_key !== modelKey || model.preset_id !== request.body.preset_id) return response.status(404).json({ error: "model_not_found" });
        }
        return response.status(201).json({ ok: true, job: await createJob({ ...request.body, bucket, type: "custom-gpu" }) });
      }
      const key = String(request.body?.key || ""), language = String(request.body?.language || "ko");
      if (!key) return response.status(400).json({ error: "input_required" });
      if (!objects.some((item) => item.key === key)) return response.status(404).json({ error: "input_not_found" });
      return response.status(201).json({ ok: true, job: await createJob({ bucket, key, language }) });
    }
    if (request.method === "DELETE") {
      const id = String(request.query?.id || ""), job = (await listJobs()).find((item) => item.id === id);
      if (job?.instance_id && !["completed", "failed", "cancelled"].includes(job.status)) return response.status(409).json({ error: "cancel_running_job_first" });
      if (job) {
        const registeredModel = job.task_mode === "training" ? (await listModels()).find((model) => model.training_job_id === job.id) : null;
        const disposableKeys = registeredModel ? [job.log_key] : [job.result_key, job.log_key, job.preview_key, job.manifest_key];
        for (const key of disposableKeys.filter(Boolean)) {
          try { await deleteObject(job.bucket, key); } catch (error) { if (!/404|NoSuchKey/i.test(String(error.message))) throw error; }
        }
      }
      await deleteJob(id);
      return response.json({ ok: true });
    }
    return response.status(405).json({ error: "method_not_allowed" });
  } catch (error) { return response.status(502).json({ error: error instanceof Error ? error.message : "jobs_failed" }); }
}
