import { ncp } from "./ncp-cloud.js";
import { CREDIT_EXPIRY, CREDITS, usageSummary } from "./usage.js";

export const MIN_CREDIT_RESERVE_KRW = 1000;

export function assertNoOtherActiveGpuJob(jobs, currentJobId) {
  if (jobs.some((job) => job.id !== currentJobId && job.instance_id && ["provisioning", "running"].includes(job.status))) throw new Error("another_gpu_job_active");
  return true;
}

export function assertActiveGpuJobLimit(jobs, currentJobId, limit = 1) {
  const maximum = Math.min(2, Math.max(1, Number(limit) || 1));
  const active = jobs.filter((job) => job.id !== currentJobId && job.instance_id && ["provisioning", "running"].includes(job.status)).length;
  if (active >= maximum) throw new Error("active_gpu_job_limit_reached");
  return true;
}

export function assertCreditCoversEstimate({ provider, estimate, remaining, expiresAt, now = new Date() }) {
  const available = Number(remaining), maximum = Number(estimate);
  if (!Number.isFinite(available) || available <= 0) throw new Error(`${provider}_credit_exhausted`);
  const expiry = new Date(`${expiresAt}T23:59:59+09:00`);
  if (!Number.isFinite(expiry.getTime()) || now.getTime() > expiry.getTime()) throw new Error(`${provider}_credit_expired`);
  const reserve = Math.max(MIN_CREDIT_RESERVE_KRW, maximum * 0.1);
  if (!Number.isFinite(maximum) || maximum <= 0 || available < maximum + reserve) throw new Error(`${provider}_credit_insufficient`);
  return { allowed: true, remaining: available, estimate: maximum, reserve };
}

export async function getProviderSpendState(provider) {
  const summary = await usageSummary();
  let used = Number(summary.totals[provider] || 0);
  if (provider === "naver") {
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const data = await ncp(`/billing/v1/cost/getContractDemandCostList?startMonth=${month}&endMonth=${month}&responseFormatType=json&pageSize=100`, process.env.NCP_BILLING_API_ENDPOINT);
    const billed = (data.getContractDemandCostListResponse?.contractDemandCostList || []).reduce((sum, item) => sum + Number(item.demandAmount || 0), 0);
    used = Math.max(used, billed);
  }
  return { provider, credit: CREDITS[provider], used, remaining: CREDITS[provider] - used, expiresAt: CREDIT_EXPIRY[provider] };
}

export async function assertProviderCanSpend(provider, estimate) {
  const state = await getProviderSpendState(provider);
  return assertCreditCoversEstimate({ provider, estimate, remaining: state.remaining, expiresAt: state.expiresAt });
}
