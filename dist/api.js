"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOctokit = createOctokit;
exports.listOrgRepos = listOrgRepos;
exports.listWorkflowRuns = listWorkflowRuns;
exports.listRunJobs = listRunJobs;
exports.fetchAllJobs = fetchAllJobs;
exports.fetchOrgWorkflowRuns = fetchOrgWorkflowRuns;
const rest_1 = require("@octokit/rest");
const p_limit_1 = __importDefault(require("p-limit"));
const cache_1 = require("./cache");
const DEFAULT_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
function createOctokit(auth) {
    return new rest_1.Octokit({
        auth: auth.token,
        baseUrl: auth.baseUrl,
    });
}
/**
 * List all repositories in an organization with pagination.
 */
async function listOrgRepos(octokit, org, onProgress, options = {}) {
    const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
    const cacheKey = ['repos', org];
    // Try cache first
    if (useCache) {
        const cached = (0, cache_1.getCache)(cacheKey, cacheTtlMs);
        if (cached) {
            onProgress?.(cached.length);
            return cached;
        }
    }
    const repos = [];
    for await (const response of octokit.paginate.iterator(octokit.rest.repos.listForOrg, { org, per_page: 100 })) {
        for (const repo of response.data) {
            repos.push({
                name: repo.name,
                full_name: repo.full_name,
                owner: repo.owner.login,
            });
        }
        onProgress?.(repos.length);
    }
    // Save to cache
    if (useCache) {
        (0, cache_1.setCache)(cacheKey, repos, cacheTtlMs);
    }
    return repos;
}
/**
 * List workflow runs for a repository within a date range.
 */
async function listWorkflowRuns(octokit, owner, repo, since, until, onProgress) {
    const runs = [];
    const sinceISO = since.toISOString().split('T')[0]; // YYYY-MM-DD format
    const untilISO = until.toISOString().split('T')[0];
    try {
        for await (const response of octokit.paginate.iterator(octokit.rest.actions.listWorkflowRunsForRepo, {
            owner,
            repo,
            status: 'completed',
            created: `${sinceISO}..${untilISO}`,
            per_page: 100,
        })) {
            for (const run of response.data) {
                // Double-check the date filter (API might return more)
                const runDate = new Date(run.created_at);
                if (runDate >= since && runDate <= until) {
                    runs.push({
                        id: run.id,
                        name: run.name,
                        status: run.status,
                        conclusion: run.conclusion,
                        created_at: run.created_at,
                        run_started_at: run.run_started_at,
                        repository: {
                            name: run.repository.name,
                            full_name: run.repository.full_name,
                        },
                    });
                }
            }
            onProgress?.(runs.length);
        }
    }
    catch (error) {
        // Some repos might not have Actions enabled
        if (error instanceof Error && error.message.includes('404')) {
            return [];
        }
        throw error;
    }
    return runs;
}
/**
 * List jobs for a specific workflow run.
 */
async function listRunJobs(octokit, owner, repo, runId) {
    const jobs = [];
    try {
        for await (const response of octokit.paginate.iterator(octokit.rest.actions.listJobsForWorkflowRun, {
            owner,
            repo,
            run_id: runId,
            per_page: 100,
        })) {
            for (const job of response.data) {
                if (job.completed_at) {
                    jobs.push({
                        id: job.id,
                        run_id: job.run_id,
                        name: job.name,
                        status: job.status,
                        conclusion: job.conclusion,
                        started_at: job.started_at,
                        completed_at: job.completed_at,
                        labels: job.labels,
                        runner_name: job.runner_name,
                        runner_group_name: job.runner_group_name,
                    });
                }
            }
        }
    }
    catch (error) {
        // Handle 404 gracefully
        if (error instanceof Error && error.message.includes('404')) {
            return [];
        }
        throw error;
    }
    return jobs;
}
/**
 * Fetch all jobs for multiple workflow runs with concurrency control.
 */
async function fetchAllJobs(octokit, runs, concurrency = 5, onProgress, options = {}) {
    const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
    // Check cache first
    const cacheKey = ['jobs', runs.map(r => r.id).sort().join(',')];
    if (useCache) {
        const cached = (0, cache_1.getCache)(cacheKey, cacheTtlMs);
        if (cached) {
            onProgress?.(runs.length, runs.length);
            return cached;
        }
    }
    const limit = (0, p_limit_1.default)(concurrency);
    const allJobs = [];
    let completed = 0;
    const tasks = runs.map((run) => limit(async () => {
        const [owner, repo] = run.repository.full_name.split('/');
        const jobs = await listRunJobs(octokit, owner, repo, run.id);
        const jobsWithRepo = jobs.map((job) => ({
            ...job,
            repo_full_name: run.repository.full_name,
            workflow_name: run.name,
        }));
        completed++;
        onProgress?.(completed, runs.length);
        return jobsWithRepo;
    }));
    const results = await Promise.all(tasks);
    for (const jobs of results) {
        allJobs.push(...jobs);
    }
    // Cache the results
    if (useCache) {
        (0, cache_1.setCache)(cacheKey, allJobs, cacheTtlMs);
    }
    return allJobs;
}
/**
 * Fetch workflow runs for all repositories in an organization.
 */
async function fetchOrgWorkflowRuns(octokit, repos, since, until, concurrency = 5, onProgress, options = {}) {
    const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
    // Check cache first
    const cacheKey = ['runs', repos.map(r => r.full_name).sort().join(','), since.toISOString(), until.toISOString()];
    if (useCache) {
        const cached = (0, cache_1.getCache)(cacheKey, cacheTtlMs);
        if (cached) {
            onProgress?.(repos.length, repos.length, cached.length);
            return cached;
        }
    }
    const limit = (0, p_limit_1.default)(concurrency);
    const allRuns = [];
    let completed = 0;
    const tasks = repos.map((repo) => limit(async () => {
        const runs = await listWorkflowRuns(octokit, repo.owner, repo.name, since, until);
        completed++;
        onProgress?.(completed, repos.length, allRuns.length + runs.length);
        return runs;
    }));
    const results = await Promise.all(tasks);
    for (const runs of results) {
        allRuns.push(...runs);
    }
    // Cache the results
    if (useCache) {
        (0, cache_1.setCache)(cacheKey, allRuns, cacheTtlMs);
    }
    return allRuns;
}
//# sourceMappingURL=api.js.map