import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCustomJob } from "../lib/jobs.js";
import { customWorkerScript } from "../api/cloud.js";
import { estimateGpu, estimateProviderGpu } from "../lib/usage.js";
import { assertActiveGpuJobLimit, assertCreditCoversEstimate, assertNoOtherActiveGpuJob } from "../lib/spend-guard.js";

process.env.SESSION_SECRET ||= "test-session-secret";
process.env.NCP_OBJECT_STORAGE_ACCESS_KEY_ID ||= "test-access";
process.env.NCP_OBJECT_STORAGE_SECRET_KEY ||= "test-secret";

const input = {
  code_key: "gpu-workbench/code.zip",
  data_key: "gpu-workbench/data.csv",
  command: "python train.py",
  output_path: "outputs",
};
assert.equal(validateCustomJob(input).command, "python train.py");
assert.equal(validateCustomJob({ ...input, provider: "naver" }).provider, "naver");
assert.equal(validateCustomJob({ ...input, task_mode: "inference" }).taskMode, "inference");
assert.equal(validateCustomJob({ ...input, model_key: "results/model.tar.gz" }).modelKey, "results/model.tar.gz");
assert.equal(validateCustomJob({ ...input, provider: "invalid" }).provider, "auto");
assert.throws(() => validateCustomJob({ ...input, output_path: "../escape" }), /unsafe_output_path/);
assert.throws(() => validateCustomJob({ ...input, command: "python train.py\nrm -rf /" }), /unsafe_command/);

const preset = readFileSync(new URL("../examples/mnist-playground/train_and_infer.py", import.meta.url), "utf8");
for (const marker of ["CGR_METRIC", "CGR_PREDICTION", "CGR_SUMMARY", "torch.cuda.is_available", "model.pt", "metrics.json", "predictions.json"]) assert.ok(preset.includes(marker), `MNIST preset missing ${marker}`);
assert.ok(statSync(new URL("../public/playground/mnist-playground.zip", import.meta.url)).size > 1000, "one-click preset ZIP must be shipped with the site");
const qwenTrain = readFileSync(new URL("../examples/qwen-lora-playground/train.py", import.meta.url), "utf8");
for (const marker of ["Qwen/Qwen2.5-7B-Instruct", "BitsAndBytesConfig", "prepare_model_for_kbit_training", "load_in_4bit", "torch.bfloat16", "r=32", "2048", "CGR_MODEL_SUMMARY"]) assert.ok(qwenTrain.includes(marker), `7B training preset missing ${marker}`);
const qwenInfer = readFileSync(new URL("../examples/qwen-lora-playground/infer.py", import.meta.url), "utf8");
const qwenRequirements = readFileSync(new URL("../examples/qwen-lora-playground/requirements.txt", import.meta.url), "utf8");
for (const marker of ["PeftModel.from_pretrained", "CGR_MODEL_DIR", "CGR_INFERENCE"]) assert.ok(qwenInfer.includes(marker), `7B inference preset missing ${marker}`);
assert.ok(statSync(new URL("../public/playground/qwen-lora-playground.zip", import.meta.url)).size > 2500, "7B train/inference ZIP must be shipped with the site");
assert.match(qwenRequirements, /^jinja2>=3\.1\.0$/m, "Qwen chat templates require Jinja2 3.1+");
const sdxlTrain = readFileSync(new URL("../examples/sdxl-lora-playground/train.py", import.meta.url), "utf8");
const sdxlInfer = readFileSync(new URL("../examples/sdxl-lora-playground/infer.py", import.meta.url), "utf8");
const sdxlRequirements = readFileSync(new URL("../examples/sdxl-lora-playground/requirements.txt", import.meta.url), "utf8");
const sdxlRender = readFileSync(new URL("../examples/sdxl-lora-playground/render_comparison.py", import.meta.url), "utf8");
for (const marker of ["stabilityai/stable-diffusion-xl-base-1.0", "TRAINER_SHA256", "checkpointing_steps", "resume_from_checkpoint", "model-metadata.json", "checkpoint-manifest.json", "1024", "BF16 DreamBooth LoRA"]) assert.ok(sdxlTrain.includes(marker), `SDXL training preset missing ${marker}`);
for (const marker of ["DEMO_DOG_IMAGES", "DEMO_DOG_REVISION", "download_demo_images", "CGR_DEMO"]) assert.ok(sdxlTrain.includes(marker), `zero-prep SDXL demo missing ${marker}`);
assert.match(sdxlTrain, /"steps_added": 100/, "zero-prep SDXL demo must finish at the first 100-step checkpoint");
assert.match(sdxlTrain, /"demo_id": bundle\.get\("demo_id"\)/, "zero-prep models must preserve their demo identity for one-click continuation");
const trainerCommand = sdxlTrain.match(/command = \[(.*?)\n    \]\n    if parent_step:/s)?.[1] || "";
const trainerFlags = [...trainerCommand.matchAll(/"(--[^" ]+)/g)].map((match) => match[1]);
const supportedTrainerFlags = new Set(["--mixed_precision=bf16", "--pretrained_model_name_or_path", "--instance_data_dir", "--output_dir", "--instance_prompt", "--resolution", "--train_batch_size", "--gradient_accumulation_steps", "--learning_rate", "--lr_scheduler", "--lr_warmup_steps", "--max_train_steps", "--checkpointing_steps", "--mixed_precision", "--gradient_checkpointing", "--allow_tf32", "--rank", "--seed", "--report_to"]);
assert.deepEqual(trainerFlags.filter((flag) => !supportedTrainerFlags.has(flag)), [], "pinned Diffusers v0.35.1 trainer command contains an unsupported literal flag");
assert.ok(!sdxlTrain.includes('"--cache_latents"'), "Diffusers v0.35.1 SDXL trainer does not accept --cache_latents");
for (const marker of ["CGR_IMAGE_INFERENCE", "checkpoint_step", "preview-grid.jpg", "manual_seed"]) assert.ok(sdxlInfer.includes(marker), `SDXL inference preset missing ${marker}`);
assert.ok(statSync(new URL("../public/playground/sdxl-lora-playground.zip", import.meta.url)).size > 5000, "SDXL train/inference ZIP must be shipped with the site");
const sdxlZip = fileURLToPath(new URL("../public/playground/sdxl-lora-playground.zip", import.meta.url));
for (const [filename, source] of [["train.py", sdxlTrain], ["infer.py", sdxlInfer], ["requirements.txt", sdxlRequirements], ["render_comparison.py", sdxlRender]]) {
  assert.equal(execFileSync("tar", ["-xOf", sdxlZip, filename], { encoding: "utf8" }).replace(/\r\n/g, "\n"), source.replace(/\r\n/g, "\n"), `SDXL deployment ZIP ${filename} must match its canonical source`);
}
const jobsApi = readFileSync(new URL("../api/jobs.js", import.meta.url), "utf8");
const cloudApi = readFileSync(new URL("../api/cloud.js", import.meta.url), "utf8");
const submitGpuJob = readFileSync(new URL("./Submit-GpuJob.ps1", import.meta.url), "utf8");
assert.match(submitGpuJob, /Connect-CclSession/, "long-running GPU polling must be able to renew its login session");
assert.match(submitGpuJob, /401,\s*403/, "GPU polling must retry authentication failures instead of abandoning a paid job");
assert.match(cloudApi, /availability_zone:\s*selectedAvailabilityZone/, "Kakao GPU creation must pin the selected subnet availability zone");
assert.match(cloudApi, /kakaoInstanceFailure\(candidate\)/, "Kakao GPU allocation failures must preserve the provider reason");
assert.match(cloudApi, /카카오 GPU 준비 실패/, "Kakao setup errors must describe the failed stage accurately");
assert.ok(jobsApi.includes('action === "log-text"'), "completed experiment logs must be readable in the result UI");
const jobsHtml = readFileSync(new URL("../public/jobs.html", import.meta.url), "utf8");
assert.match(jobsHtml, /jobs\.css\?v=[a-z0-9-]+/i, "jobs CSS URL must be versioned so browsers cannot mix old layouts");
assert.match(jobsHtml, /jobs-app\.js\?v=[a-z0-9-]+/i, "jobs JS URL must be versioned so browsers cannot run stale UI code");
const jobsCss = readFileSync(new URL("../public/jobs.css", import.meta.url), "utf8");
assert.ok(jobsCss.includes("white-space:nowrap"), "compact labels and actions must not break one Korean character per line");
const vercelConfig = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
assert.ok(vercelConfig.includes('"source": "/jobs"') && vercelConfig.includes('"value": "no-store"'), "protected jobs document must not remain stale after deployment");

const script = customWorkerScript({
  id: "job-1", bucket: "bucket", ...input,
  result_key: "results/a.tar.gz", log_key: "logs/a.txt", max_minutes: 60,
});
assert.ok(script.includes("https://cloud-gpu-runner.vercel.app/api/worker-callback"), "worker callback must use the current protected production origin");
for (const expected of ["timeout 60m", "CGR_DATA_DIR", "CGR_DATA_FILE", "shutdown -h now", "finish completed", "output directory is empty", "trap - ERR", "WORKDIR=/workspace", "execution timeout", "progress code_download", "progress command", "network activation timeout", "seq 1 150", "post_callback", "seq 1 5", "if ! python3 -m pip --version", "apt-get install -y python3-pip"]) {
  assert.ok(script.includes(expected), `worker script missing ${expected}`);
}
for (const expected of ["snapshot_loop", "sleep 120", "upload_snapshot", "snapshot_uploaded", "artifact_uploaded", "result artifact upload failed", "make_snapshot", "--exclude='outputs/checkpoint-*'", "preview-grid.jpg", "checkpoint-manifest.json", '"stage":"checkpoint"']) assert.ok(script.includes(expected), `checkpoint worker missing ${expected}`);
assert.ok(!script.includes("tar -czf /tmp/result.tar.gz -C /workspace ."), "worker must never archive the entire workspace as fallback");
assert.ok(script.indexOf("if ! python3 -m pip --version") < script.indexOf("apt-get install -y python3-pip"), "pip installation must be conditional");
assert.ok(script.includes('--data-binary @"$file"'), "callbacks must retry the same JSON file without broken nested shell quotes");
assert.ok(!script.includes('-d "{"status"'), "worker must not generate syntactically broken nested JSON quotes");
assert.ok(Buffer.byteLength(script, "utf8") < 16 * 1024, "cloud-init must stay below Kakao's 16KB user_data limit");
const longScript = customWorkerScript({ id: "job-2", bucket: "bucket", ...input, result_key: "results/b.tar.gz", log_key: "logs/b.txt", max_minutes: 1440 });
assert.ok(longScript.includes("X-Amz-Expires=93600"), "24-hour work must keep artifact URLs valid through runtime plus cleanup buffer");
const inferenceScript = customWorkerScript({ id: "job-3", bucket: "bucket", ...input, model_key: "results/model.tar.gz", result_key: "results/c.tar.gz", log_key: "logs/c.txt", max_minutes: 30 });
for (const expected of ["progress model_download", "CGR_MODEL_DIR=/workspace/model-artifact", "/tmp/model.tar.gz"]) assert.ok(inferenceScript.includes(expected), `inference worker missing ${expected}`);
const estimate = estimateGpu("gn1i.xlarge", 60, 80);
assert.equal(estimate.gpu, 648);
assert.equal(estimate.disk, 12.8);
assert.equal(estimate.public_ip, 5.5);
assert.ok(Math.abs(estimate.total - 666.3098) < 0.0001, "estimate must include GPU, disk, public IP and four storage requests");
const naverEstimate = estimateProviderGpu("naver", "gp1l4-g3", 60, 80);
assert.equal(naverEstimate.gpu, 1447);
assert.ok(Math.abs(naverEstimate.disk - 11.2) < 0.000001);
assert.equal(naverEstimate.public_ip, 5.6);
assert.ok(Math.abs(naverEstimate.total - 1463.8098) < 0.0001, "NAVER estimate must include L4, block storage, public IP and object requests");
const now = new Date("2026-07-14T00:00:00Z");
assert.throws(() => assertCreditCoversEstimate({ provider: "naver", estimate: 100, remaining: 0, expiresAt: "2026-07-31", now }), /credit_exhausted/);
assert.throws(() => assertCreditCoversEstimate({ provider: "naver", estimate: 100, remaining: 1050, expiresAt: "2026-07-31", now }), /credit_insufficient/);
assert.throws(() => assertCreditCoversEstimate({ provider: "naver", estimate: 100, remaining: 5000, expiresAt: "2026-07-13", now }), /credit_expired/);
assert.equal(assertCreditCoversEstimate({ provider: "naver", estimate: 100, remaining: 5000, expiresAt: "2026-07-31", now }).allowed, true);
assert.throws(() => assertNoOtherActiveGpuJob([{ id: "existing", instance_id: "vm", status: "running" }], "new"), /another_gpu_job_active/);
assert.equal(assertNoOtherActiveGpuJob([{ id: "old", instance_id: "vm", status: "completed" }], "new"), true);
assert.equal(assertActiveGpuJobLimit([{ id: "one", instance_id: "vm-1", status: "running" }], "new", 2), true);
assert.throws(() => assertActiveGpuJobLimit([
  { id: "one", instance_id: "vm-1", status: "running" },
  { id: "two", instance_id: "vm-2", status: "provisioning" },
], "new", 2), /active_gpu_job_limit_reached/);
console.log("GPU workbench contract tests OK");
