import { readFile, writeFile } from "node:fs/promises";
import { ncp, ncpPath } from "../../lib/ncp-cloud.js";

const volumeCount = Math.max(1, Math.min(12, Number(process.argv[2] || 7)));
const cutoffEpoch = Number(process.argv[3]);
const statePath = String(process.argv[4] || "");
const volumeType = String(process.argv[5] || "CB2");
const gbHourRate = Number(process.argv[6] || 0.16);
if (!cutoffEpoch || !statePath) throw new Error("cutoff_epoch_and_state_path_required");

const serverStatePaths = [
  "C:/dev/cloud-gpu-runner/etc/kakaotalk-persona/cpu-fleet-test.json",
  "C:/dev/cloud-gpu-runner/etc/kakaotalk-persona/cpu-fleet-s16.json",
];
const serverIds = [];
for (const path of serverStatePaths) {
  const fleet = JSON.parse(await readFile(path, "utf8"));
  serverIds.push(...fleet.entries.filter((entry) => entry.instance_id).map((entry) => entry.instance_id));
}
if (!serverIds.length) throw new Error("capacity_benchmark_servers_missing");

const state = {
  status: "creating",
  created_at: new Date().toISOString(),
  cutoff_epoch: cutoffEpoch,
  requested: volumeCount,
  volume_size_gb: 16380,
  gb_hour_rate: gbHourRate,
  volume_type: volumeType,
  entries: [],
};
const save = async () => writeFile(statePath, JSON.stringify(state, null, 2));
await save();

for (let index = 0; index < volumeCount; index += 1) {
  try {
    const response = await ncp("/vserver/v2/createBlockStorageInstance", undefined, { method: "POST", form: {
      regionCode: "KR", zoneCode: "KR-2", blockStorageName: `cgr-vector-${state.volume_type.toLowerCase()}-${String(index + 1).padStart(2, "0")}`,
      blockStorageVolumeTypeCode: state.volume_type, blockStorageSize: String(state.volume_size_gb),
      blockStorageDescription: "Ephemeral large-vector-index capacity and attachment benchmark",
      isReturnProtection: "false", responseFormatType: "json",
    }});
    const volume = response.createBlockStorageInstanceResponse?.blockStorageInstanceList?.[0];
    if (!volume?.blockStorageInstanceNo) throw new Error("block_storage_number_missing");
    state.entries.push({
      index, volume_id: volume.blockStorageInstanceNo, server_id: serverIds[index % serverIds.length],
      billing_started_at: new Date().toISOString(), status: "provisioning",
    });
    await save();
  } catch (error) {
    state.entries.push({ index, status: "launch_failed", error: String(error.message).slice(0, 300) });
    await save();
    if (/quota|limit|exceed|1153/i.test(String(error.message))) break;
  }
}

for (const entry of state.entries.filter((item) => item.volume_id)) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await ncp(ncpPath("/vserver/v2/getBlockStorageInstanceDetail", {
      regionCode: "KR", blockStorageInstanceNo: entry.volume_id,
    }));
    const volume = response.getBlockStorageInstanceDetailResponse?.blockStorageInstanceList?.[0];
    if (volume?.blockStorageInstanceStatus?.code === "CREAT" && volume?.blockStorageInstanceOperation?.code === "NULL") break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  try {
    await ncp("/vserver/v2/attachBlockStorageInstance", undefined, { method: "POST", form: {
      regionCode: "KR", blockStorageInstanceNo: entry.volume_id,
      serverInstanceNo: entry.server_id, responseFormatType: "json",
    }});
    entry.status = "attaching";
    entry.attach_requested_at = new Date().toISOString();
  } catch (error) {
    entry.status = "created_unattached";
    entry.attach_error = String(error.message).slice(0, 300);
  }
  await save();
}
state.created = state.entries.filter((entry) => entry.volume_id).length;
state.total_capacity_gb = state.created * state.volume_size_gb;
state.status = state.created ? "running" : "failed";
await save();
console.log(JSON.stringify({ status: state.status, requested: state.requested, created: state.created, total_capacity_gb: state.total_capacity_gb }));
