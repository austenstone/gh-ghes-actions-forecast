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
    byOS: Record<OSType, {
        minutes: number;
        billableMinutes: number;
        jobCount: number;
    }>;
    byWorkflow: Record<string, {
        minutes: number;
        billableMinutes: number;
        jobCount: number;
        runCount: number;
    }>;
    byRepo: Record<string, {
        minutes: number;
        billableMinutes: number;
        jobCount: number;
        workflows: Set<string>;
    }>;
    byDate: Record<string, {
        minutes: number;
        billableMinutes: number;
        jobCount: number;
    }>;
    jobCount: number;
    runCount: number;
    jobs: BillingResult[];
}
export declare const MULTIPLIERS: Record<OSType, number>;
/**
 * Parse custom label mappings from CLI input.
 * Format: "pattern:os,pattern:os" (e.g., "runner-*:linux,mac-*:macos")
 */
export declare function parseLabelMappings(input: string): LabelMapping[];
/**
 * Detect OS type from runner labels.
 */
export declare function detectOS(labels: string[], customMappings?: LabelMapping[]): OSType;
/**
 * Get the billing multiplier for an OS type.
 */
export declare function getMultiplier(os: OSType): number;
/**
 * Calculate the duration in minutes between two timestamps.
 * GitHub rounds UP to the nearest minute per job.
 */
export declare function calculateDurationMinutes(startedAt: string, completedAt: string): number;
/**
 * Calculate billable minutes for a job.
 */
export declare function calculateBillableMinutes(startedAt: string, completedAt: string, multiplier: number): number;
/**
 * Process a single job and return billing details.
 */
export declare function processJob(job: JobWithRepo, customMappings?: LabelMapping[]): BillingResult;
/**
 * Process all jobs and aggregate billing data.
 */
export declare function aggregateBilling(jobs: JobWithRepo[], customMappings?: LabelMapping[]): AggregatedBilling;
/**
 * Estimate cost based on GitHub.com pricing.
 * Note: Actual GHES costs vary by agreement; this is an estimate based on public pricing.
 *
 * As of 2024, GitHub Actions pricing per minute:
 * - Linux: $0.008/min
 * - Windows: $0.016/min (2x)
 * - macOS: $0.08/min (10x)
 */
export declare const COST_PER_MINUTE: Record<OSType, number>;
export declare function estimateCost(billing: AggregatedBilling): number;
/**
 * Project costs forward based on historical data.
 */
export declare function projectCosts(billing: AggregatedBilling, daysOfData: number): {
    daily: number;
    weekly: number;
    monthly: number;
};
//# sourceMappingURL=billing.d.ts.map