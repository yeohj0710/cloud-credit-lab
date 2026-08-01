import assert from "node:assert/strict";
import { buildLaunchConfigs, selectNcpLaunchResources, isNcpGpuQuotaError, privateGpuAcgs, requiredZoneForSpec, NCP_GPU_HOURLY, NCP_BLOCK_STORAGE_GIB_HOUR, NCP_PUBLIC_IP_HOURLY } from "../lib/ncp-gpu.js";
import { ncpPath } from "../lib/ncp-cloud.js";
import { gpuCost } from "../lib/gpu-resources.js";

assert.equal(NCP_GPU_HOURLY["gp1l4-g3"], 1447);
assert.equal(NCP_BLOCK_STORAGE_GIB_HOUR, 0.14);
assert.equal(NCP_PUBLIC_IP_HOURLY, 5.6);
assert.equal(isNcpGpuQuotaError(new Error('NCP 3005004 Cannot create any more than the creation limit of Server (VPC). Product Type: [G3] VM > GPU > L40S Creation Limit: 0')), true);
assert.equal(isNcpGpuQuotaError(new Error("network timeout")), false);
assert.equal(requiredZoneForSpec("gp1ls16-g3"), "KR-2");
assert.equal(requiredZoneForSpec("gp1l4-g3"), null);
assert.deepEqual(privateGpuAcgs([
  { accessControlGroupName: "default" },
  { accessControlGroupName: "cgr-private-training", accessControlGroupNo: "safe" },
]), [{ accessControlGroupName: "cgr-private-training", accessControlGroupNo: "safe" }]);
assert.deepEqual(buildLaunchConfigs(
  [{ subnetNo: "s1", vpcNo: "v1", subnetName: "public", subnetType: { code: "PUBLIC" } }, { subnetNo: "s2", vpcNo: "v2", subnetName: "private", subnetType: { code: "PRIVATE" } }],
  [{ accessControlGroupNo: "a1", accessControlGroupName: "default", vpcNo: "v1" }, { accessControlGroupNo: "a2", accessControlGroupName: "wrong", vpcNo: "v3" }],
), [{ vpc_no: "v1", subnet_no: "s1", acg_no: "a1", zone_code: undefined, label: "public · default" }]);
const selected = selectNcpLaunchResources({
  subnets: [{ subnetNo: 101, vpcNo: 201 }], vpcs: [{ vpcNo: 201 }],
  keys: [{ keyName: "key" }], acgs: [{ accessControlGroupNo: 301, vpcNo: 201 }],
  launch_configs: [{ subnet_no: 101, vpc_no: 201, acg_no: 301 }],
}, { subnet_no: "101", vpc_no: "201", login_key_name: "key", acg_no: "301" });
assert.equal(selected.subnet.subnetNo, 101);
assert.equal(selected.vpc.vpcNo, 201);
assert.equal(selected.acg.accessControlGroupNo, 301);
assert.equal(selected.key.loginKeyName, "key");
assert.equal(selectNcpLaunchResources({ subnets: [], vpcs: [], keys: [{ keyName: "key" }], acgs: [], launch_configs: [] }, { login_key_name: "" }).key, undefined);
const path = ncpPath("/vserver/v2/getServerSpecList", { regionCode: "KR", serverImageNo: "123" });
assert.ok(path.includes("regionCode=KR"));
assert.ok(path.includes("serverImageNo=123"));
assert.ok(path.endsWith("responseFormatType=json"));
const now = Date.parse("2026-07-13T01:00:00Z");
const cost = gpuCost({ provider: "naver", billing_started_at: "2026-07-13T00:00:00Z", hourly_rate: 1447, volume_gb: 80, disk_gib_hour_rate: 0.14 }, now);
assert.equal(cost.seconds, 3600);
assert.equal(cost.gpu, 1447);
assert.ok(Math.abs(cost.disk - 11.2) < 0.000001);
assert.equal(cost.publicIp, 5.6);
console.log("NCP GPU contract tests OK");
