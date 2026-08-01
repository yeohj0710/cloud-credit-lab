import { readFile, writeFile } from "node:fs/promises";
import { ncp, ncpPath } from "../../lib/ncp-cloud.js";
import { addUsage } from "../../lib/usage.js";

const statePath = String(process.argv[2] || "");
if (!statePath) throw new Error("state_path_required");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let state = JSON.parse(await readFile(statePath, "utf8"));
const save = async () => writeFile(statePath, JSON.stringify(state, null, 2));
const remainingMs = Math.max(0, state.cutoff_epoch * 1000 - Date.now());
if (remainingMs) await wait(remainingMs);

const entries = state.entries.filter((entry) => entry.volume_id);
state.cleanup_started_at = new Date().toISOString();
await save();
for (const entry of entries) {
  try {
    await ncp("/vserver/v2/detachBlockStorageInstances", undefined, { method: "POST", form: {
      regionCode: "KR", "blockStorageInstanceNoList.1": entry.volume_id, responseFormatType: "json",
    }});
    entry.status = "detaching";
  } catch (error) {
    entry.detach_error = String(error.message).slice(0, 300);
  }
  await save();
}

const detachDeadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < detachDeadline) {
  let ready = 0;
  for (const entry of entries) {
    const response = await ncp(ncpPath("/vserver/v2/getBlockStorageInstanceDetail", {
      regionCode: "KR", blockStorageInstanceNo: entry.volume_id,
    })).catch(() => null);
    const volume = response?.getBlockStorageInstanceDetailResponse?.blockStorageInstanceList?.[0];
    if (!volume || (!volume.serverInstanceNo && volume.blockStorageInstanceOperation?.code === "NULL")) ready += 1;
  }
  if (ready === entries.length) break;
  await wait(10_000);
}

const deleteForm = { regionCode: "KR", responseFormatType: "json" };
entries.forEach((entry, index) => { deleteForm[`blockStorageInstanceNoList.${index + 1}`] = entry.volume_id; });
try {
  await ncp("/vserver/v2/deleteBlockStorageInstances", undefined, { method: "POST", form: deleteForm });
  state.delete_requested_at = new Date().toISOString();
  state.status = "deleting";
  await save();
} catch (error) {
  state.status = "cleanup_failed";
  state.cleanup_error = String(error.message).slice(0, 500);
  await save();
  throw error;
}

const deleteDeadline = Date.now() + 20 * 60 * 1000;
while (Date.now() < deleteDeadline) {
  const response = await ncp(ncpPath("/vserver/v2/getBlockStorageInstanceList", { regionCode: "KR" })).catch(() => null);
  const existing = new Set((response?.getBlockStorageInstanceListResponse?.blockStorageInstanceList || []).map((item) => String(item.blockStorageInstanceNo)));
  if (entries.every((entry) => !existing.has(String(entry.volume_id)))) {
    state.status = "completed";
    state.deleted_at = new Date().toISOString();
    break;
  }
  await wait(10_000);
}
if (state.status !== "completed") {
  state.status = "cleanup_unverified";
  state.cleanup_error = "block_storage_delete_confirmation_timeout";
}
const end = new Date(state.delete_requested_at || state.cleanup_started_at).getTime();
let total = 0;
for (const entry of entries) {
  const seconds = Math.max(0, (end - new Date(entry.billing_started_at).getTime()) / 1000);
  entry.usage_seconds = seconds;
  entry.usage_amount = seconds / 3600 * state.volume_size_gb * state.gb_hour_rate;
  total += entry.usage_amount;
}
state.usage_amount = total;
await addUsage({
  provider: "naver", category: "storage", action: state.status,
  label: "Large vector-index block-storage lifecycle benchmark",
  amount: total,
  meta: { volumes: entries.length, total_capacity_gb: state.total_capacity_gb },
});
await save();
console.log(JSON.stringify({ status: state.status, volumes: entries.length, total_capacity_gb: state.total_capacity_gb, usage_amount: total }));
