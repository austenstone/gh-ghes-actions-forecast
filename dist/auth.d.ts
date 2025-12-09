export interface AuthConfig {
    token: string;
    baseUrl: string;
}
/**
 * Get authentication token and base URL for GitHub API.
 *
 * Priority:
 * 1. GH_TOKEN env var (works for both github.com and GHES)
 * 2. GH_ENTERPRISE_TOKEN env var (for GHES-specific auth)
 * 3. `gh auth token` command (uses gh CLI's stored credentials)
 *
 * @param host - Optional GHES hostname (e.g., "github.mycompany.com")
 */
export declare function getAuth(host?: string): AuthConfig;
