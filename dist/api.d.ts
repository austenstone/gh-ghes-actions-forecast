import { Octokit } from '@octokit/core';
import { AuthConfig } from './auth';
declare const ThrottledOctokit: typeof Octokit & import("@octokit/core/dist-types/types").Constructor<import("@octokit/plugin-rest-endpoint-methods").Api & {
    paginate: import("@octokit/plugin-paginate-rest").PaginateInterface;
} & {
    retry: {
        retryRequest: (error: import("@octokit/request-error").RequestError, retries: number, retryAfter: number) => import("@octokit/request-error").RequestError;
    };
}>;
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
export declare function createOctokit(auth: AuthConfig, onRateLimit?: (retryAfter: number, options: object) => void): ThrottledOctokitInstance;
/**
 * List all repositories in an organization with pagination.
 */
export declare function listOrgRepos(octokit: ThrottledOctokitInstance, org: string, onProgress?: (count: number) => void, options?: FetchOptions): Promise<Repository[]>;
/**
 * List workflow runs for a repository within a date range.
 */
export declare function listWorkflowRuns(octokit: ThrottledOctokitInstance, owner: string, repo: string, since: Date, until: Date, onProgress?: (count: number) => void): Promise<WorkflowRun[]>;
/**
 * List jobs for a specific workflow run.
 */
export declare function listRunJobs(octokit: ThrottledOctokitInstance, owner: string, repo: string, runId: number): Promise<WorkflowJob[]>;
/**
 * Fetch all jobs for multiple workflow runs with concurrency control.
 */
export declare function fetchAllJobs(octokit: ThrottledOctokitInstance, runs: WorkflowRun[], concurrency?: number, onProgress?: (completed: number, total: number) => void, options?: FetchOptions): Promise<JobWithRepo[]>;
/**
 * Fetch workflow runs for all repositories in an organization.
 */
export declare function fetchOrgWorkflowRuns(octokit: ThrottledOctokitInstance, repos: Repository[], since: Date, until: Date, concurrency?: number, onProgress?: (completed: number, total: number, runCount: number) => void, options?: FetchOptions): Promise<WorkflowRun[]>;
export {};
