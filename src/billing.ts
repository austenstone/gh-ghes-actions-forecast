import { JobWithRepo } from './api';

export type OSType = 'linux' | 'windows' | 'macos' | 'unknown';

export interface LabelMapping {
  pattern: string;
  os: OSType;
}

export interface BillingResult {
  job: JobWithRepo;
  os: OSType;
  durationMinutes: number;
  multiplier: number;
  billableMinutes: number;
}

export interface AggregatedBilling {
  totalMinutes: number;
  totalBillableMinutes: number;
  byOS: Record<OSType, { minutes: number; billableMinutes: number; jobCount: number }>;
  byWorkflow: Record<string, { minutes: number; billableMinutes: number; jobCount: number; runCount: number }>;
  byRepo: Record<string, { minutes: number; billableMinutes: number; jobCount: number; workflows: Set<string> }>;
  byDate: Record<string, { minutes: number; billableMinutes: number; jobCount: number }>;
  jobCount: number;
  runCount: number;
  jobs: BillingResult[];
}

// GitHub.com billing multipliers
export const MULTIPLIERS: Record<OSType, number> = {
  linux: 1,
  windows: 2,
  macos: 10,
  unknown: 1, // Default to Linux pricing for unknown
};

// Default patterns for OS detection from runner labels
const DEFAULT_PATTERNS: LabelMapping[] = [
  // GitHub-hosted runners
  { pattern: 'ubuntu', os: 'linux' },
  { pattern: 'linux', os: 'linux' },
  { pattern: 'windows', os: 'windows' },
  { pattern: 'win', os: 'windows' },
  { pattern: 'macos', os: 'macos' },
  { pattern: 'mac', os: 'macos' },
  { pattern: 'darwin', os: 'macos' },
];

/**
 * Parse custom label mappings from CLI input.
 * Format: "pattern:os,pattern:os" (e.g., "runner-*:linux,mac-*:macos")
 */
export function parseLabelMappings(input: string): LabelMapping[] {
  if (!input) return [];
  
  return input.split(',').map((mapping) => {
    const [pattern, os] = mapping.trim().split(':');
    if (!pattern || !os) {
      throw new Error(`Invalid label mapping: ${mapping}. Expected format: "pattern:os"`);
    }
    
    const normalizedOS = os.toLowerCase() as OSType;
    if (!['linux', 'windows', 'macos'].includes(normalizedOS)) {
      throw new Error(`Invalid OS type: ${os}. Must be linux, windows, or macos`);
    }
    
    return { pattern: pattern.toLowerCase(), os: normalizedOS };
  });
}

/**
 * Check if a label matches a pattern (supports * wildcard).
 */
function matchesPattern(label: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*/g, '.*'); // Convert * to .*
  
  return new RegExp(`^${regexPattern}$`, 'i').test(label);
}

/**
 * Detect OS type from runner labels.
 */
export function detectOS(labels: string[], customMappings: LabelMapping[] = []): OSType {
  const lowerLabels = labels.map((l) => l.toLowerCase());
  
  // Check custom mappings first (user overrides)
  for (const mapping of customMappings) {
    for (const label of lowerLabels) {
      if (matchesPattern(label, mapping.pattern)) {
        return mapping.os;
      }
    }
  }
  
  // Check default patterns
  for (const mapping of DEFAULT_PATTERNS) {
    for (const label of lowerLabels) {
      if (label.includes(mapping.pattern)) {
        return mapping.os;
      }
    }
  }
  
  return 'unknown';
}

/**
 * Get the billing multiplier for an OS type.
 */
export function getMultiplier(os: OSType): number {
  return MULTIPLIERS[os];
}

/**
 * Calculate the duration in minutes between two timestamps.
 * GitHub rounds UP to the nearest minute per job.
 */
export function calculateDurationMinutes(startedAt: string, completedAt: string): number {
  const start = new Date(startedAt);
  const end = new Date(completedAt);
  const durationMs = end.getTime() - start.getTime();
  
  // Round up to nearest minute (GitHub billing behavior)
  return Math.ceil(durationMs / 1000 / 60);
}

/**
 * Calculate billable minutes for a job.
 */
export function calculateBillableMinutes(
  startedAt: string,
  completedAt: string,
  multiplier: number
): number {
  const durationMinutes = calculateDurationMinutes(startedAt, completedAt);
  return durationMinutes * multiplier;
}

/**
 * Process a single job and return billing details.
 */
export function processJob(job: JobWithRepo, customMappings: LabelMapping[] = []): BillingResult {
  const os = detectOS(job.labels, customMappings);
  const multiplier = getMultiplier(os);
  const durationMinutes = calculateDurationMinutes(job.started_at, job.completed_at!);
  const billableMinutes = durationMinutes * multiplier;
  
  return {
    job,
    os,
    durationMinutes,
    multiplier,
    billableMinutes,
  };
}

/**
 * Process all jobs and aggregate billing data.
 */
export function aggregateBilling(
  jobs: JobWithRepo[],
  customMappings: LabelMapping[] = []
): AggregatedBilling {
  const seenRunIds = new Set<number>();
  
  const result: AggregatedBilling = {
    totalMinutes: 0,
    totalBillableMinutes: 0,
    byOS: {
      linux: { minutes: 0, billableMinutes: 0, jobCount: 0 },
      windows: { minutes: 0, billableMinutes: 0, jobCount: 0 },
      macos: { minutes: 0, billableMinutes: 0, jobCount: 0 },
      unknown: { minutes: 0, billableMinutes: 0, jobCount: 0 },
    },
    byWorkflow: {},
    byRepo: {},
    byDate: {},
    jobCount: 0,
    runCount: 0,
    jobs: [],
  };
  
  for (const job of jobs) {
    if (!job.completed_at) continue;
    
    const billing = processJob(job, customMappings);
    result.jobs.push(billing);
    
    // Track unique runs
    seenRunIds.add(job.run_id);
    
    // Totals
    result.totalMinutes += billing.durationMinutes;
    result.totalBillableMinutes += billing.billableMinutes;
    result.jobCount++;
    
    // By OS
    result.byOS[billing.os].minutes += billing.durationMinutes;
    result.byOS[billing.os].billableMinutes += billing.billableMinutes;
    result.byOS[billing.os].jobCount++;
    
    // By workflow (repo/workflow_name)
    const workflowKey = `${job.repo_full_name}/${job.workflow_name || 'unknown'}`;
    if (!result.byWorkflow[workflowKey]) {
      result.byWorkflow[workflowKey] = { minutes: 0, billableMinutes: 0, jobCount: 0, runCount: 0 };
    }
    result.byWorkflow[workflowKey].minutes += billing.durationMinutes;
    result.byWorkflow[workflowKey].billableMinutes += billing.billableMinutes;
    result.byWorkflow[workflowKey].jobCount++;
    
    // By repo
    const repoKey = job.repo_full_name;
    if (!result.byRepo[repoKey]) {
      result.byRepo[repoKey] = { minutes: 0, billableMinutes: 0, jobCount: 0, workflows: new Set() };
    }
    result.byRepo[repoKey].minutes += billing.durationMinutes;
    result.byRepo[repoKey].billableMinutes += billing.billableMinutes;
    result.byRepo[repoKey].jobCount++;
    result.byRepo[repoKey].workflows.add(job.workflow_name || 'unknown');
    
    // By date (YYYY-MM-DD)
    const dateKey = job.started_at.split('T')[0];
    if (!result.byDate[dateKey]) {
      result.byDate[dateKey] = { minutes: 0, billableMinutes: 0, jobCount: 0 };
    }
    result.byDate[dateKey].minutes += billing.durationMinutes;
    result.byDate[dateKey].billableMinutes += billing.billableMinutes;
    result.byDate[dateKey].jobCount++;
  }
  
  // Count unique runs per workflow
  for (const job of jobs) {
    if (!job.completed_at) continue;
    const workflowKey = `${job.repo_full_name}/${job.workflow_name || 'unknown'}`;
    // We need to track runs per workflow, so let's use a map
  }
  
  // Calculate run counts per workflow (separate pass for accuracy)
  const runsByWorkflow = new Map<string, Set<number>>();
  for (const job of jobs) {
    if (!job.completed_at) continue;
    const workflowKey = `${job.repo_full_name}/${job.workflow_name || 'unknown'}`;
    if (!runsByWorkflow.has(workflowKey)) {
      runsByWorkflow.set(workflowKey, new Set());
    }
    runsByWorkflow.get(workflowKey)!.add(job.run_id);
  }
  for (const [key, runs] of runsByWorkflow) {
    if (result.byWorkflow[key]) {
      result.byWorkflow[key].runCount = runs.size;
    }
  }
  
  result.runCount = seenRunIds.size;
  
  return result;
}

/**
 * Estimate cost based on GitHub.com pricing.
 * Note: Actual GHES costs vary by agreement; this is an estimate based on public pricing.
 * 
 * As of 2024, GitHub Actions pricing per minute:
 * - Linux: $0.008/min
 * - Windows: $0.016/min (2x)
 * - macOS: $0.08/min (10x)
 */
export const COST_PER_MINUTE: Record<OSType, number> = {
  linux: 0.008,
  windows: 0.016,
  macos: 0.08,
  unknown: 0.008,
};

export function estimateCost(billing: AggregatedBilling): number {
  let totalCost = 0;
  
  for (const [os, data] of Object.entries(billing.byOS)) {
    totalCost += data.minutes * COST_PER_MINUTE[os as OSType];
  }
  
  return totalCost;
}

/**
 * Project costs forward based on historical data.
 */
export function projectCosts(
  billing: AggregatedBilling,
  daysOfData: number
): { daily: number; weekly: number; monthly: number } {
  const dailyMinutes = billing.totalBillableMinutes / daysOfData;
  const dailyCost = estimateCost(billing) / daysOfData;
  
  return {
    daily: dailyCost,
    weekly: dailyCost * 7,
    monthly: dailyCost * 30,
  };
}
