import { Octokit } from '@octokit/core';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import pLimit from 'p-limit';
import { AuthConfig } from './auth';
import { getCache, setCache } from './cache';

// Create Octokit with all necessary plugins
const ThrottledOctokit = Octokit.plugin(restEndpointMethods, paginateRest, throttling, retry);

// Type for our custom Octokit instance
type ThrottledOctokitInstance = InstanceType<typeof ThrottledOctokit>;

export interface Repository {
  name: string;
  full_name: string;
  owner: string;
}

export interface WorkflowRun {
  id: number;
  name: string | null | undefined;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  repository: {
    name: string;
    full_name: string;
  };
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
  labels: string[];
  runner_name: string | null;
  runner_group_name: string | null;
}

export interface JobWithRepo extends WorkflowJob {
  repo_full_name: string;
  workflow_name: string | null | undefined;
}

export interface FetchOptions {
  useCache?: boolean;
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

export function createOctokit(auth: AuthConfig, onRateLimit?: (retryAfter: number, options: object) => void): ThrottledOctokitInstance {
  return new ThrottledOctokit({
    auth: auth.token,
    baseUrl: auth.baseUrl,
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit: unknown, retryCount: number) => {
        onRateLimit?.(retryAfter, options);
        // Retry twice after hitting rate limit
        if (retryCount < 2) {
          return true;
        }
        return false;
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit: unknown, retryCount: number) => {
        onRateLimit?.(retryAfter, options);
        // Retry once on secondary rate limit (abuse detection)
        if (retryCount < 1) {
          return true;
        }
        return false;
      },
    },
    retry: {
      doNotRetry: ['429'],
    },
  });
}

/**
 * List all repositories in an organization with pagination.
 */
export async function listOrgRepos(
  octokit: ThrottledOctokitInstance,
  org: string,
  onProgress?: (count: number) => void,
  options: FetchOptions = {}
): Promise<Repository[]> {
  const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
  const cacheKey = ['repos', org];
  
  // Try cache first
  if (useCache) {
    const cached = getCache<Repository[]>(cacheKey, cacheTtlMs);
    if (cached) {
      onProgress?.(cached.length);
      return cached;
    }
  }
  
  const repos: Repository[] = [];
  
  for await (const response of octokit.paginate.iterator(
    octokit.rest.repos.listForOrg,
    { org, per_page: 100 }
  )) {
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
    setCache(cacheKey, repos, cacheTtlMs);
  }
  
  return repos;
}

/**
 * List workflow runs for a repository within a date range.
 */
export async function listWorkflowRuns(
  octokit: ThrottledOctokitInstance,
  owner: string,
  repo: string,
  since: Date,
  until: Date,
  onProgress?: (count: number) => void
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = [];
  const sinceISO = since.toISOString().split('T')[0]; // YYYY-MM-DD format
  const untilISO = until.toISOString().split('T')[0];
  
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.actions.listWorkflowRunsForRepo,
      {
        owner,
        repo,
        status: 'completed' as const,
        created: `${sinceISO}..${untilISO}`,
        per_page: 100,
      }
    )) {
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
  } catch (error: unknown) {
    // Skip repos that are inaccessible, don't have Actions, or throw any API error
    // Common cases: 404 (not found), 403 (forbidden), 409 (conflict/empty repo)
    return [];
  }
  
  return runs;
}

/**
 * List jobs for a specific workflow run.
 */
export async function listRunJobs(
  octokit: ThrottledOctokitInstance,
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];
  
  try {
    for await (const response of octokit.paginate.iterator(
      octokit.rest.actions.listJobsForWorkflowRun,
      {
        owner,
        repo,
        run_id: runId,
        per_page: 100,
      }
    )) {
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
  } catch (error: unknown) {
    // Skip jobs that are inaccessible or throw any API error
    return [];
  }
  
  return jobs;
}

/**
 * Fetch all jobs for multiple workflow runs with concurrency control.
 */
export async function fetchAllJobs(
  octokit: ThrottledOctokitInstance,
  runs: WorkflowRun[],
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void,
  options: FetchOptions = {}
): Promise<JobWithRepo[]> {
  const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
  
  // Check cache first
  const cacheKey = ['jobs', runs.map(r => r.id).sort().join(',')];
  if (useCache) {
    const cached = getCache<JobWithRepo[]>(cacheKey, cacheTtlMs);
    if (cached) {
      onProgress?.(runs.length, runs.length);
      return cached;
    }
  }

  const limit = pLimit(concurrency);
  const allJobs: JobWithRepo[] = [];
  let completed = 0;
  
  const tasks = runs.map((run) =>
    limit(async () => {
      const [owner, repo] = run.repository.full_name.split('/');
      const jobs = await listRunJobs(octokit, owner, repo, run.id);
      
      const jobsWithRepo: JobWithRepo[] = jobs.map((job) => ({
        ...job,
        repo_full_name: run.repository.full_name,
        workflow_name: run.name,
      }));
      
      completed++;
      onProgress?.(completed, runs.length);
      
      return jobsWithRepo;
    })
  );
  
  const results = await Promise.all(tasks);
  for (const jobs of results) {
    allJobs.push(...jobs);
  }

  // Cache the results
  if (useCache) {
    setCache(cacheKey, allJobs, cacheTtlMs);
  }
  
  return allJobs;
}

/**
 * Fetch workflow runs for all repositories in an organization.
 */
export async function fetchOrgWorkflowRuns(
  octokit: ThrottledOctokitInstance,
  repos: Repository[],
  since: Date,
  until: Date,
  concurrency: number = 5,
  onProgress?: (completed: number, total: number, runCount: number) => void,
  options: FetchOptions = {}
): Promise<WorkflowRun[]> {
  const { useCache = true, cacheTtlMs = DEFAULT_CACHE_TTL } = options;
  
  // Check cache first
  const cacheKey = ['runs', repos.map(r => r.full_name).sort().join(','), since.toISOString(), until.toISOString()];
  if (useCache) {
    const cached = getCache<WorkflowRun[]>(cacheKey, cacheTtlMs);
    if (cached) {
      onProgress?.(repos.length, repos.length, cached.length);
      return cached;
    }
  }

  const limit = pLimit(concurrency);
  const allRuns: WorkflowRun[] = [];
  let completed = 0;
  
  const tasks = repos.map((repo) =>
    limit(async () => {
      const runs = await listWorkflowRuns(octokit, repo.owner, repo.name, since, until);
      
      completed++;
      onProgress?.(completed, repos.length, allRuns.length + runs.length);
      
      return runs;
    })
  );
  
  const results = await Promise.all(tasks);
  for (const runs of results) {
    allRuns.push(...runs);
  }

  // Cache the results
  if (useCache) {
    setCache(cacheKey, allRuns, cacheTtlMs);
  }
  
  return allRuns;
}
