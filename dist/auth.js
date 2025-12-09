"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAuth = getAuth;
const child_process_1 = require("child_process");
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
function getAuth(host) {
    const token = resolveToken(host);
    const baseUrl = resolveBaseUrl(host);
    return { token, baseUrl };
}
function resolveToken(host) {
    // Check environment variables first
    if (process.env.GH_TOKEN) {
        return process.env.GH_TOKEN;
    }
    if (process.env.GH_ENTERPRISE_TOKEN) {
        return process.env.GH_ENTERPRISE_TOKEN;
    }
    if (process.env.GITHUB_TOKEN) {
        return process.env.GITHUB_TOKEN;
    }
    // Fall back to gh CLI auth
    try {
        const args = host ? ['--hostname', host] : [];
        const command = `gh auth token ${args.join(' ')}`.trim();
        const token = (0, child_process_1.execSync)(command, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
        }).trim();
        if (!token) {
            throw new Error('Empty token returned from gh auth');
        }
        return token;
    }
    catch (error) {
        throw new Error(`Unable to get authentication token. Please either:\n` +
            `  1. Run 'gh auth login'${host ? ` --hostname ${host}` : ''}\n` +
            `  2. Set GH_TOKEN environment variable\n` +
            `  3. Set GH_ENTERPRISE_TOKEN environment variable (for GHES)`);
    }
}
function resolveBaseUrl(host) {
    // Check for explicit base URL override
    if (process.env.GH_ENTERPRISE_URL) {
        return normalizeBaseUrl(process.env.GH_ENTERPRISE_URL);
    }
    if (process.env.GITHUB_API_URL) {
        return normalizeBaseUrl(process.env.GITHUB_API_URL);
    }
    // Build URL from host
    if (host) {
        return `https://${host}/api/v3`;
    }
    // Default to github.com
    return 'https://api.github.com';
}
function normalizeBaseUrl(url) {
    // Remove trailing slash
    return url.replace(/\/+$/, '');
}
//# sourceMappingURL=auth.js.map