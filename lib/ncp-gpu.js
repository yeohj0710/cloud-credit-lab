import { ncp, ncpList, ncpPath } from "./ncp-cloud.js";
import { gpuCapability, isHighValueCloudGpu } from "./gpu-policy.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const NCP_GPU_HOURLY = {
  "gp1l4-g3": 1447, "gp1l8-g3": 1550, "gp2l8-g3": 2893,
  "gp2l16-g3": 3100, "gp4l16-g3": 4721, "gp4l32-g3": 5501,
  "gp1ls16-g3": 4309, "gp1ls32-g3": 5504, "gp2ls32-g3": 8617,
  "gp2ls64-g3": 11007, "gp4ls64-g3": 16401, "gp4ls120-g3": 20782,
};
export const NCP_BLOCK_STORAGE_GIB_HOUR = 0.14;
export const NCP_PUBLIC_IP_HOURLY = 5.6;
export const NCP_PRIVATE_GPU_ACG_NAME = "cgr-private-training";

export function privateGpuAcgs(acgs) {
  return acgs.filter((item) => item.accessControlGroupName === NCP_PRIVATE_GPU_ACG_NAME);
}

export async function ensurePrivateNcpGpuAcg(vpcNo, regionCode = "KR") {
  const common = { regionCode, pageNo: "1", pageSize: "1000" };
  const list = await ncp(ncpPath("/vserver/v2/getAccessControlGroupList", common));
  let acg = privateGpuAcgs(ncpList(list, "getAccessControlGroupListResponse", "accessControlGroupList"))
    .find((item) => String(item.vpcNo) === String(vpcNo));
  if (acg) return acg;
  const created = await ncp(ncpPath("/vserver/v2/createAccessControlGroup", {
    regionCode, vpcNo, accessControlGroupName: NCP_PRIVATE_GPU_ACG_NAME,
    accessControlGroupDescription: "Ephemeral GPU workers; no inbound access",
  }));
  acg = first(created, "createAccessControlGroupResponse", "accessControlGroupList");
  if (!acg?.accessControlGroupNo) throw new Error("ncp_private_gpu_acg_create_failed");
  await ncp(ncpPath("/vserver/v2/addAccessControlGroupOutboundRule", {
    regionCode, vpcNo, accessControlGroupNo: acg.accessControlGroupNo,
    "accessControlGroupRuleList.1.protocolTypeCode": "TCP", "accessControlGroupRuleList.1.ipBlock": "0.0.0.0/0", "accessControlGroupRuleList.1.portRange": "53",
    "accessControlGroupRuleList.2.protocolTypeCode": "UDP", "accessControlGroupRuleList.2.ipBlock": "0.0.0.0/0", "accessControlGroupRuleList.2.portRange": "53",
    "accessControlGroupRuleList.3.protocolTypeCode": "TCP", "accessControlGroupRuleList.3.ipBlock": "0.0.0.0/0", "accessControlGroupRuleList.3.portRange": "80",
    "accessControlGroupRuleList.4.protocolTypeCode": "TCP", "accessControlGroupRuleList.4.ipBlock": "0.0.0.0/0", "accessControlGroupRuleList.4.portRange": "443",
  }));
  return acg;
}

export function isNcpGpuQuotaError(error) {
  return /3005004|creation limit|service quota/i.test(String(error?.message || error));
}

export function requiredZoneForSpec(specCode) {
  return /^gp\d+ls\d+-g3$/i.test(String(specCode || "")) ? "KR-2" : null;
}

function first(data, responseName, listName) { return ncpList(data, responseName, listName)[0]; }
function gpuLabel(spec) {
  const code = spec.serverSpecCode || "";
  const model = code.includes("ls") ? "L40S" : code.includes("l4") || /^gp\d+l\d/.test(code) ? "L4" : "GPU";
  const count = Number(code.match(/^gp(\d+)/)?.[1] || 1);
  return `${model} ${count}개 · ${spec.cpuCount || 0} vCPU · ${Math.round(Number(spec.memorySize || 0) / 1073741824)}GB RAM`;
}

export function buildLaunchConfigs(subnets, acgs) {
  return subnets.filter((subnet) => subnet.subnetType?.code === "PUBLIC").flatMap((subnet) => acgs
    .filter((acg) => acg.vpcNo === subnet.vpcNo)
    .map((acg) => ({ vpc_no: subnet.vpcNo, subnet_no: subnet.subnetNo, acg_no: acg.accessControlGroupNo, zone_code: subnet.zoneCode, label: `${subnet.subnetName} · ${acg.accessControlGroupName}` })));
}

const sameId = (left, right) => String(left ?? "") === String(right ?? "");
export function selectNcpLaunchResources(readiness, config) {
  const subnet = readiness.subnets.find((item) => sameId(item.subnetNo, config.subnet_no));
  const vpc = readiness.vpcs.find((item) => sameId(item.vpcNo, config.vpc_no || subnet?.vpcNo));
  const requestedKeyName = String(config.login_key_name || "");
  const rawKey = requestedKeyName ? readiness.keys.find((item) => sameId(item.loginKeyName || item.keyName, requestedKeyName)) : undefined;
  const key = rawKey ? { ...rawKey, loginKeyName: rawKey.loginKeyName || rawKey.keyName } : undefined;
  const acg = readiness.acgs.find((item) => sameId(item.accessControlGroupNo, config.acg_no));
  const launchConfig = readiness.launch_configs.find((item) => sameId(item.vpc_no, vpc?.vpcNo) && sameId(item.subnet_no, subnet?.subnetNo) && sameId(item.acg_no, acg?.accessControlGroupNo));
  return { subnet, vpc, key, acg, launchConfig };
}

export async function ncpGpuReadiness(regionCode = "KR") {
  const common = { regionCode, pageNo: "1", pageSize: "1000" };
  const [imageData, vpcData, subnetData, keyData, acgData] = await Promise.all([
    ncp(ncpPath("/vserver/v2/getServerImageList", { ...common, "platformCategoryCodeList.1": "GPU", "osTypeCodeList.1": "UBUNTU", "serverImageTypeCodeList.1": "NCP" })),
    ncp(ncpPath("/vpc/v2/getVpcList", common)),
    ncp(ncpPath("/vpc/v2/getSubnetList", common)),
    ncp(ncpPath("/vserver/v2/getLoginKeyList", common)),
    ncp(ncpPath("/vserver/v2/getAccessControlGroupList", common)),
  ]);
  const images = ncpList(imageData, "getServerImageListResponse", "serverImageList");
  const specGroups = await Promise.all(images.slice(0, 20).map(async (image) => {
    const data = await ncp(ncpPath("/vserver/v2/getServerSpecList", { ...common, serverImageNo: image.serverImageNo }));
    return ncpList(data, "getServerSpecListResponse", "serverSpecList")
      .filter((spec) => NCP_GPU_HOURLY[spec.serverSpecCode])
      .map((spec) => ({ ...spec, serverImageNo: image.serverImageNo, serverImageName: image.serverImageName }));
  }));
  const allSpecs = [...new Map(specGroups.flat().sort((a, b) => NCP_GPU_HOURLY[a.serverSpecCode] - NCP_GPU_HOURLY[b.serverSpecCode]).map((spec) => [spec.serverSpecCode, spec])).values()];
  const specs = allSpecs.filter((spec) => isHighValueCloudGpu("naver", spec));
  const vpcs = ncpList(vpcData, "getVpcListResponse", "vpcList");
  const subnets = ncpList(subnetData, "getSubnetListResponse", "subnetList").filter((item) => (item.subnetStatus?.code === "RUN" || !item.subnetStatus) && item.subnetType?.code === "PUBLIC");
  const keys = ncpList(keyData, "getLoginKeyListResponse", "loginKeyList");
  const allAcgs = ncpList(acgData, "getAccessControlGroupListResponse", "accessControlGroupList");
  const acgs = privateGpuAcgs(allAcgs);
  const launchConfigs = buildLaunchConfigs(subnets, acgs);
  const compatibleLaunchConfigs = launchConfigs.filter((config) => specs.some((spec) => !requiredZoneForSpec(spec.serverSpecCode) || requiredZoneForSpec(spec.serverSpecCode) === config.zone_code));
  return {
    ok: Boolean(specs.length && compatibleLaunchConfigs.length && keys.length),
    provider: "naver", regionCode,
    policy: { mode: "capability-first", local_gpu: "RTX 5070 Ti 16GB", minimum_vram_per_gpu_gb: 48 },
    specs: specs.map((spec) => ({ ...spec, ...gpuCapability("naver", spec), hourly_rate: NCP_GPU_HOURLY[spec.serverSpecCode], required_zone_code: requiredZoneForSpec(spec.serverSpecCode), label: gpuLabel(spec) })),
    rejected_specs: allSpecs.filter((spec) => !isHighValueCloudGpu("naver", spec)).map((spec) => ({ serverSpecCode: spec.serverSpecCode, reason: "local_equivalent_or_lower_vram" })),
    vpcs, subnets, keys, acgs, launch_configs: compatibleLaunchConfigs,
    missing: [!specs.length && "GPU 사양", !vpcs.length && "VPC", !subnets.length && "Public Subnet", !keys.length && "로그인 키", !compatibleLaunchConfigs.length && "GPU 지원 존의 Public Subnet/ACG"].filter(Boolean),
  };
}

export async function bootstrapNcpGpu(regionCode = "KR") {
  const common = { regionCode, pageNo: "1", pageSize: "100" };
  const [vpcData, subnetData, keyData] = await Promise.all([
    ncp(ncpPath("/vpc/v2/getVpcList", common)),
    ncp(ncpPath("/vpc/v2/getSubnetList", common)),
    ncp(ncpPath("/vserver/v2/getLoginKeyList", common)),
  ]);
  const vpcs = ncpList(vpcData, "getVpcListResponse", "vpcList");
  let subnets = ncpList(subnetData, "getSubnetListResponse", "subnetList");
  const reusableSubnet = subnets.find((item) => item.subnetType?.code === "PUBLIC" && (item.subnetStatus?.code === "RUN" || !item.subnetStatus));
  let vpc = vpcs.find((item) => item.vpcNo === reusableSubnet?.vpcNo) || vpcs.find((item) => item.vpcName === "cgr-gpu-vpc");
  let createdVpc = false;
  if (!vpc) {
    const data = await ncp(ncpPath("/vpc/v2/createVpc", { regionCode, vpcName: "cgr-gpu-vpc", ipv4CidrBlock: "10.30.0.0/16" }));
    vpc = first(data, "createVpcResponse", "vpcList");
    createdVpc = true;
  }
  let keys = ncpList(keyData, "getLoginKeyListResponse", "loginKeyList");
  let privateKey;
  if (!keys.length) {
    const data = await ncp(ncpPath("/vserver/v2/createLoginKey", { regionCode, keyName: "cgr-gpu" }));
    privateKey = data.createLoginKeyResponse?.privateKey;
    keys = [{ loginKeyName: data.createLoginKeyResponse?.keyName || "cgr-gpu" }];
  }
  if (createdVpc || vpc?.vpcStatus?.code !== "RUN") return { ok: false, stage: "vpc_creating", message: "VPC를 만드는 중이에요. 잠시 후 자동으로 계속할게요.", private_key: privateKey };
  subnets = subnets.filter((item) => item.vpcNo === vpc.vpcNo);
  const targetZone = "KR-2";
  const existing = subnets.find((item) => item.subnetType?.code === "PUBLIC" && item.zoneCode === targetZone);
  if (!existing) {
    const aclData = await ncp(ncpPath("/vpc/v2/getNetworkAclList", { ...common, vpcNo: vpc.vpcNo }));
    const acls = ncpList(aclData, "getNetworkAclListResponse", "networkAclList");
    const acl = acls.find((item) => item.isDefault) || acls[0];
    if (!acl) throw new Error("ncp_default_network_acl_missing");
    await ncp(ncpPath("/vpc/v2/createSubnet", {
      regionCode, zoneCode: targetZone, vpcNo: vpc.vpcNo, subnetName: "cgr-gpu-kr2-public",
      subnet: "10.30.2.0/24", networkAclNo: acl.networkAclNo, subnetTypeCode: "PUBLIC", usageTypeCode: "GEN",
    }));
    return { ok: false, stage: "subnet_creating", message: "Public Subnet을 만드는 중이에요. 잠시 후 자동으로 계속할게요.", private_key: privateKey };
  }
  await ensurePrivateNcpGpuAcg(vpc.vpcNo, regionCode);
  const readiness = await ncpGpuReadiness(regionCode);
  return { ...readiness, stage: readiness.ok ? "ready" : "waiting", private_key: privateKey };
}

export async function createNcpGpu(job, config, script) {
  const regionCode = config.region_code || "KR";
  const readiness = await ncpGpuReadiness(regionCode);
  const spec = readiness.specs.find((item) => item.serverSpecCode === config.spec_code);
  if (!spec) throw new Error("ncp_gpu_spec_unavailable");
  const requiredZone = requiredZoneForSpec(spec.serverSpecCode);
  if (requiredZone && readiness.launch_configs.every((item) => item.zone_code !== requiredZone)) throw new Error("ncp_gpu_compatible_subnet_missing");
  const { subnet, vpc, key, acg, launchConfig } = selectNcpLaunchResources(readiness, config);
  if (!subnet || !vpc || !key || !acg || !launchConfig) throw new Error("ncp_gpu_network_configuration_missing");
  const initName = `cgr-${job.id.replace(/-/g, "").slice(0, 18)}`;
  const initData = await ncp("/vserver/v2/createInitScript", undefined, { method: "POST", form: {
    regionCode, initScriptContent: script, initScriptName: initName,
    initScriptDescription: "Cloud GPU Runner ephemeral GPU worker", osTypeCode: "LNX", responseFormatType: "json",
  }});
  const init = first(initData, "createInitScriptResponse", "initScriptList");
  if (!init?.initScriptNo) throw new Error("ncp_init_script_create_failed");
  try {
    const createData = await ncp("/vserver/v2/createServerInstances", undefined, { method: "POST", form: {
      regionCode, serverImageNo: spec.serverImageNo, serverSpecCode: spec.serverSpecCode,
      vpcNo: vpc.vpcNo, subnetNo: subnet.subnetNo, feeSystemTypeCode: "MTRAT",
      serverCreateCount: "1", serverName: initName, loginKeyName: key.loginKeyName,
      initScriptNo: init.initScriptNo, associateWithPublicIp: "true", isPreInstallGpuDriver: "true",
      "networkInterfaceList.1.networkInterfaceOrder": "0",
      "networkInterfaceList.1.accessControlGroupNoList.1": acg.accessControlGroupNo,
      responseFormatType: "json",
    }});
    const instance = first(createData, "createServerInstancesResponse", "serverInstanceList");
    if (!instance?.serverInstanceNo) throw new Error("ncp_gpu_create_failed");
    return { instance, init_script_no: init.initScriptNo, spec };
  } catch (error) {
    await deleteNcpInitScript(init.initScriptNo, regionCode).catch(() => {});
    throw error;
  }
}

export async function getNcpInstance(instanceNo, regionCode = "KR") {
  const data = await ncp(ncpPath("/vserver/v2/getServerInstanceList", { regionCode, "serverInstanceNoList.1": instanceNo }));
  return first(data, "getServerInstanceListResponse", "serverInstanceList");
}

export async function deleteNcpInitScript(initScriptNo, regionCode = "KR") {
  if (!initScriptNo) return;
  await ncp(ncpPath("/vserver/v2/deleteInitScripts", { regionCode, "initScriptNoList.1": initScriptNo }));
}

export async function deleteNcpGpu(job) {
  const instanceNo = job?.instance_id;
  const regionCode = job?.region_code || "KR";
  if (!instanceNo) return { publicIpRemoved: false };
  let instance;
  try { instance = await getNcpInstance(instanceNo, regionCode); }
  catch (error) { if (!/404|not exist/i.test(String(error.message))) throw error; }
  const publicIpId = job.public_ip_id || instance?.publicIpInstanceNo;
  let publicIpRemoved = false;
  if (publicIpId) {
    try {
      await ncp(ncpPath("/vserver/v2/disassociatePublicIpFromServerInstance", { regionCode, publicIpInstanceNo: publicIpId }));
    } catch (error) {
      if (!/404|not exist|already|28102/i.test(String(error.message))) throw error;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await ncp(ncpPath("/vserver/v2/deletePublicIpInstance", { regionCode, publicIpInstanceNo: publicIpId }));
        publicIpRemoved = true;
        break;
      } catch (error) {
        if (/404|not exist/i.test(String(error.message))) { publicIpRemoved = true; break; }
        if (attempt === 4 || !/changing|25031|25032/i.test(String(error.message))) throw error;
        await wait(1000);
      }
    }
  }
  if (instance) {
    const status = instance.serverInstanceStatus?.code;
    if (!["NSTOP", "TERMT", "NULL"].includes(status)) {
      await ncp(ncpPath("/vserver/v2/stopServerInstances", { regionCode, "serverInstanceNoList.1": instanceNo }));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(1000);
        instance = await getNcpInstance(instanceNo, regionCode);
        if (instance?.serverInstanceStatus?.code === "NSTOP") break;
      }
      if (instance?.serverInstanceStatus?.code !== "NSTOP") throw new Error("ncp_gpu_stop_timeout");
    }
    if (instance?.serverInstanceStatus?.code === "NSTOP") {
      await ncp(ncpPath("/vserver/v2/terminateServerInstances", { regionCode, "serverInstanceNoList.1": instanceNo }));
      let terminated = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await wait(1000);
        try {
          instance = await getNcpInstance(instanceNo, regionCode);
          if (!instance || instance.serverInstanceStatus?.code === "TERMT") { terminated = true; break; }
        } catch (error) {
          if (/404|not exist/i.test(String(error.message))) { terminated = true; break; }
          throw error;
        }
      }
      if (!terminated) throw new Error("ncp_gpu_termination_pending");
    }
  }
  try { await deleteNcpInitScript(job.init_script_no, regionCode); }
  catch (error) { if (!/404|not exist/i.test(String(error.message))) throw error; }
  return { publicIpRemoved };
}
