"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COST_PER_MINUTE = exports.MULTIPLIERS = void 0;
exports.parseLabelMappings = parseLabelMappings;
exports.detectOS = detectOS;
exports.getMultiplier = getMultiplier;
exports.calculateDurationMinutes = calculateDurationMinutes;
exports.calculateBillableMinutes = calculateBillableMinutes;
exports.processJob = processJob;
exports.aggregateBilling = aggregateBilling;
exports.estimateCost = estimateCost;
exports.projectCosts = projectCosts;
// GitHub.com billing multipliers
exports.MULTIPLIERS = {
    linux: 1,
    windows: 2,
    macos: 10,
    unknown: 1, // Default to Linux pricing for unknown
};
// Default patterns for OS detection from runner labels
const DEFAULT_PATTERNS = [
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
function parseLabelMappings(input) {
    if (!input)
        return [];
    return input.split(',').map((mapping) => {
        const [pattern, os] = mapping.trim().split(':');
        if (!pattern || !os) {
            throw new Error(`Invalid label mapping: ${mapping}. Expected format: "pattern:os"`);
        }
        const normalizedOS = os.toLowerCase();
        if (!['linux', 'windows', 'macos'].includes(normalizedOS)) {
            throw new Error(`Invalid OS type: ${os}. Must be linux, windows, or macos`);
        }
        return { pattern: pattern.toLowerCase(), os: normalizedOS };
    });
}
/**
 * Check if a label matches a pattern (supports * wildcard).
 */
function matchesPattern(label, pattern) {
    // Convert glob pattern to regex
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
        .replace(/\*/g, '.*'); // Convert * to .*
    return new RegExp(`^${regexPattern}$`, 'i').test(label);
}
/**
 * Detect OS type from runner labels.
 */
function detectOS(labels, customMappings = []) {
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
function getMultiplier(os) {
    return exports.MULTIPLIERS[os];
}
/**
 * Calculate the duration in minutes between two timestamps.
 * GitHub rounds UP to the nearest minute per job.
 */
function calculateDurationMinutes(startedAt, completedAt) {
    const start = new Date(startedAt);
    const end = new Date(completedAt);
    const durationMs = end.getTime() - start.getTime();
    // Round up to nearest minute (GitHub billing behavior)
    return Math.ceil(durationMs / 1000 / 60);
}
/**
 * Calculate billable minutes for a job.
 */
function calculateBillableMinutes(startedAt, completedAt, multiplier) {
    const durationMinutes = calculateDurationMinutes(startedAt, completedAt);
    return durationMinutes * multiplier;
}
/**
 * Process a single job and return billing details.
 */
function processJob(job, customMappings = []) {
    const os = detectOS(job.labels, customMappings);
    const multiplier = getMultiplier(os);
    const durationMinutes = calculateDurationMinutes(job.started_at, job.completed_at);
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
function aggregateBilling(jobs, customMappings = []) {
    const seenRunIds = new Set();
    const result = {
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
        if (!job.completed_at)
            continue;
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
        if (!job.completed_at)
            continue;
        const workflowKey = `${job.repo_full_name}/${job.workflow_name || 'unknown'}`;
        // We need to track runs per workflow, so let's use a map
    }
    // Calculate run counts per workflow (separate pass for accuracy)
    const runsByWorkflow = new Map();
    for (const job of jobs) {
        if (!job.completed_at)
            continue;
        const workflowKey = `${job.repo_full_name}/${job.workflow_name || 'unknown'}`;
        if (!runsByWorkflow.has(workflowKey)) {
            runsByWorkflow.set(workflowKey, new Set());
        }
        runsByWorkflow.get(workflowKey).add(job.run_id);
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
exports.COST_PER_MINUTE = {
    linux: 0.008,
    windows: 0.016,
    macos: 0.08,
    unknown: 0.008,
};
function estimateCost(billing) {
    let totalCost = 0;
    for (const [os, data] of Object.entries(billing.byOS)) {
        totalCost += data.minutes * exports.COST_PER_MINUTE[os];
    }
    return totalCost;
}
/**
 * Project costs forward based on historical data.
 */
function projectCosts(billing, daysOfData) {
    const dailyMinutes = billing.totalBillableMinutes / daysOfData;
    const dailyCost = estimateCost(billing) / daysOfData;
    return {
        daily: dailyCost,
        weekly: dailyCost * 7,
        monthly: dailyCost * 30,
    };
}
//# sourceMappingURL=billing.js.map