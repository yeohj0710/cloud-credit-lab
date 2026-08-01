import { readFile, writeFile } from "node:fs/promises";
import { ncp, ncpPath } from "../../lib/ncp-cloud.js";

const statePath = String(process.argv[2] || "");
if (!statePath) throw new Error("state_path_required");
const state = JSON.parse(await readFile(statePath, "utf8"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = async () => writeFile(statePath, JSON.stringify(state, null, 2));

for (const entry of state.entries.filter((item) => item.volume_id)) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let currentVolume;
  while (Date.now() < deadline) {
    const response = await ncp(ncpPath("/vserver/v2/getBlockStorageInstanceDetail", {
      regionCode: "KR", blockStorageInstanceNo: entry.volume_id,
    }));
    currentVolume = response.getBlockStorageInstanceDetailResponse?.blockStorageInstanceList?.[0];
    if (currentVolume?.serverInstanceNo || (currentVolume?.blockStorageInstanceStatus?.code === "CREAT" && currentVolume?.blockStorageInstanceOperation?.code === "NULL")) break;
    await wait(5_000);
  }
  if (currentVolume?.serverInstanceNo) {
    entry.status = "attached";
    entry.attach_verified_at = new Date().toISOString();
    await save();
    continue;
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
console.log(JSON.stringify({ status: state.status, created: state.created, total_capacity_gb: state.total_capacity_gb }));
