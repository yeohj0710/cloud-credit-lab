import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ncp, ncpPath } from "../../lib/ncp-cloud.js";
import { deleteNcpInitScript, ncpGpuReadiness } from "../../lib/ncp-gpu.js";
import { listJobs } from "../../lib/jobs.js";
import { presignObject } from "../../lib/ncp-storage.js";

const fleetSize = Math.max(1, Math.min(10, Number(process.argv[2] || 6)));
const cutoffEpoch = Number(process.argv[3]);
const statePath = String(process.argv[4] || "");
const serverSpecCode = String(process.argv[5] || "s64-g3");
const hourlyRate = Number(process.argv[6] || 3904);
const isG2ProductCode = serverSpecCode.startsWith("SVR.");
if (!cutoffEpoch || !statePath) throw new Error("cutoff_epoch_and_state_path_required");

const gpuJob = (await listJobs()).find((job) => job.id === "643b441a-6e87-4994-957c-b2bc6ce9b862");
if (!gpuJob?.bucket || !gpuJob?.data_key) throw new Error("active_private_dataset_not_found");
const readiness = await ncpGpuReadiness("KR");
const launch = readiness.launch_configs.find((item) => item.zone_code === "KR-2") || readiness.launch_configs[0];
const key = readiness.keys[0];
if (!launch || !key) throw new Error("ncp_cpu_launch_configuration_missing");
const loginKeyName = key.loginKeyName || key.keyName;
const fleetId = randomUUID();
const dataUrl = presignObject(gpuJob.bucket, gpuJob.data_key, "GET", 36000);
const entries = [];
const state = {
  fleet_id: fleetId,
  status: "launching",
  created_at: new Date().toISOString(),
  cutoff_epoch: cutoffEpoch,
  bucket: gpuJob.bucket,
  server_spec_code: serverSpecCode,
  hourly_rate: hourlyRate,
  disk_gib_hour_rate: 0.16,
  volume_gb: 50,
  public_ip_hourly_rate: 5.6,
  entries,
};
await writeFile(statePath, JSON.stringify(state, null, 2));

function workerScript(shard, resultUrl) {
  const python = String.raw`
import hashlib, io, json, os, tarfile, time, urllib.request
from pathlib import Path
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

shard = int(os.environ["AUDIT_SHARD"])
shards = int(os.environ["AUDIT_SHARDS"])
cutoff = int(os.environ["AUDIT_CUTOFF"])
result_url = os.environ["AUDIT_RESULT_URL"]
root = Path("/workspace/audit")
with tarfile.open(root / "data.tar.gz", "r:gz") as archive:
    for name in ("train.jsonl", "eval.jsonl"):
        source = archive.extractfile(name)
        if source is None: raise RuntimeError("dataset_member_missing")
        (root / name).write_bytes(source.read())

torch.set_num_threads(max(1, os.cpu_count() or 1))
tokenizer = AutoTokenizer.from_pretrained("BAAI/bge-m3")
model = AutoModel.from_pretrained("BAAI/bge-m3")
model.eval()
records = []
ordinal = 0
for split in ("train", "eval"):
    with (root / f"{split}.jsonl").open(encoding="utf-8") as handle:
        for line_no, line in enumerate(handle):
            if ordinal % shards == shard:
                row = json.loads(line)
                text = row["messages"][1]["content"] + "\n" + row["messages"][2]["content"]
                records.append((0 if split == "train" else 1, line_no, hashlib.sha256(text.encode()).digest()[:16], text))
            ordinal += 1

vectors, split_ids, line_ids, hashes = [], [], [], []
def upload_checkpoint():
    if not vectors: return
    buffer = io.BytesIO()
    np.savez_compressed(buffer, vectors=np.asarray(vectors, dtype=np.float16), split=np.asarray(split_ids, dtype=np.uint8), line=np.asarray(line_ids, dtype=np.int32), text_sha256_128=np.asarray(hashes, dtype="S16"), shard=np.int16(shard), shards=np.int16(shards))
    request = urllib.request.Request(result_url, data=buffer.getvalue(), method="PUT", headers={"Content-Type":"application/octet-stream"})
    urllib.request.urlopen(request, timeout=300).read()

batch_size = 8
for start in range(0, len(records), batch_size):
    if time.time() >= cutoff - 300: break
    batch = records[start:start + batch_size]
    encoded = tokenizer([item[3] for item in batch], padding=True, truncation=True, max_length=512, return_tensors="pt")
    with torch.no_grad():
        output = model(**encoded).last_hidden_state
        mask = encoded["attention_mask"].unsqueeze(-1)
        pooled = (output * mask).sum(1) / mask.sum(1).clamp(min=1)
        pooled = torch.nn.functional.normalize(pooled, p=2, dim=1).cpu().numpy().astype(np.float16)
    vectors.extend(pooled)
    split_ids.extend(item[0] for item in batch)
    line_ids.extend(item[1] for item in batch)
    hashes.extend(item[2] for item in batch)
    if len(vectors) % 2000 < batch_size: upload_checkpoint()
upload_checkpoint()
print(json.dumps({"shard": shard, "embedded_rows": len(vectors), "candidate_rows": len(records)}))
`;
  return `#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/cgr-cpu-audit.log) 2>&1
mkdir -p /workspace/audit
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq python3-pip curl ca-certificates
else
  dnf install -y -q python3-pip curl ca-certificates tar gzip
fi
curl --fail --location --retry 10 '${dataUrl}' -o /workspace/audit/data.tar.gz
export PIP_BREAK_SYSTEM_PACKAGES=1
python3 -m pip install --quiet --upgrade pip
python3 -m pip install --quiet --index-url https://download.pytorch.org/whl/cpu torch
python3 -m pip install --quiet transformers sentencepiece numpy
cat > /workspace/audit/run.py <<'PY'
${python}
PY
export AUDIT_SHARD='${shard}' AUDIT_SHARDS='${fleetSize}' AUDIT_CUTOFF='${cutoffEpoch}' AUDIT_RESULT_URL='${resultUrl}'
python3 /workspace/audit/run.py
shutdown -h now
`;
}

for (let shard = 0; shard < fleetSize; shard += 1) {
  const resultKey = `cpu-audit/${fleetId}/shard-${shard}.npz`;
  const resultUrl = presignObject(gpuJob.bucket, resultKey, "PUT", 36000);
  const initName = `cgr-audit-${fleetId.replaceAll("-", "").slice(0, 10)}-${shard}`;
  let initScriptNo;
  try {
    const initData = await ncp("/vserver/v2/createInitScript", undefined, { method: "POST", form: {
      regionCode: "KR", initScriptContent: workerScript(shard, resultUrl), initScriptName: initName,
      initScriptDescription: "Private KakaoTalk embedding audit shard", osTypeCode: "LNX", responseFormatType: "json",
    }});
    initScriptNo = initData.createInitScriptResponse?.initScriptList?.[0]?.initScriptNo;
    if (!initScriptNo) throw new Error("cpu_audit_init_script_failed");
    const productSelection = isG2ProductCode
      ? { serverImageProductCode: "SW.VSVR.OS.LNX64.ROCKY.0808.B050", serverProductCode: serverSpecCode }
      : { serverImageNo: "104630229", serverSpecCode };
    const created = await ncp("/vserver/v2/createServerInstances", undefined, { method: "POST", form: {
      regionCode: "KR", ...productSelection,
      vpcNo: launch.vpc_no, subnetNo: launch.subnet_no, feeSystemTypeCode: "MTRAT",
      serverCreateCount: "1", serverName: initName, loginKeyName,
      initScriptNo, associateWithPublicIp: "true",
      "networkInterfaceList.1.networkInterfaceOrder": "0",
      "networkInterfaceList.1.accessControlGroupNoList.1": launch.acg_no,
      responseFormatType: "json",
    }});
    const instance = created.createServerInstancesResponse?.serverInstanceList?.[0];
    if (!instance?.serverInstanceNo) throw new Error("cpu_audit_server_create_failed");
    entries.push({
      shard, instance_id: instance.serverInstanceNo, init_script_no: initScriptNo,
      result_key: resultKey, billing_started_at: new Date().toISOString(), status: "provisioning",
    });
    await writeFile(statePath, JSON.stringify(state, null, 2));
  } catch (error) {
    if (initScriptNo) await deleteNcpInitScript(initScriptNo, "KR").catch(() => {});
    entries.push({ shard, init_script_no: initScriptNo || null, result_key: resultKey, status: "launch_failed", error: String(error.message).slice(0, 200) });
    await writeFile(statePath, JSON.stringify(state, null, 2));
    if (/creation limit|service quota|3005004/i.test(String(error.message))) break;
  }
}
state.status = entries.some((entry) => entry.instance_id) ? "running" : "failed";
state.launched = entries.filter((entry) => entry.instance_id).length;
await writeFile(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ fleet_id: fleetId, requested: fleetSize, launched: state.launched, failed: entries.filter((entry) => !entry.instance_id).length }));
