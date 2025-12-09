"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const chalk_1 = __importDefault(require("chalk"));
const cli_progress_1 = __importDefault(require("cli-progress"));
const cli_table3_1 = __importDefault(require("cli-table3"));
const date_fns_1 = require("date-fns");
const auth_1 = require("./auth");
const api_1 = require("./api");
const billing_1 = require("./billing");
const cache_1 = require("./cache");
const program = new commander_1.Command();
program
    .name('gh-forecast')
    .description('Forecast GitHub Actions minutes usage for GHES organizations')
    .version('1.0.0')
    .requiredOption('-o, --org <org>', 'GitHub organization name')
    .option('-d, --days <days>', 'Number of days to analyze (ignored if --start is used)', '30')
    .option('--start <date>', 'Start date (YYYY-MM-DD)')
    .option('--end <date>', 'End date (YYYY-MM-DD, defaults to today)')
    .option('-H, --host <host>', 'GitHub Enterprise Server hostname (e.g., github.mycompany.com)')
    .option('-c, --concurrency <number>', 'API request concurrency limit', '5')
    .option('-m, --map <mappings>', 'Custom label-to-OS mappings (e.g., "runner-*:linux,mac-*:macos")')
    .option('--output <format>', 'Output format: table, json, csv', 'table')
    .option('--group-by <period>', 'Group results by: day, week, month', 'day')
    .option('--top-repos <n>', 'Show top N repositories by usage', '10')
    .option('--show-workflows', 'Show workflow-level breakdown', false)
    .option('--show-jobs', 'Show individual job details', false)
    .option('--no-cache', 'Disable caching')
    .option('--clear-cache', 'Clear all cached data and exit')
    .option('--cache-ttl <minutes>', 'Cache TTL in minutes', '30')
    .option('--verbose', 'Show detailed progress', false)
    .action(async (options) => {
    await run(options);
});
async function run(options) {
    // Handle clear cache command
    if (options.clearCache) {
        const stats = (0, cache_1.getCacheStats)();
        if (stats.files === 0) {
            console.log(chalk_1.default.yellow('Cache is already empty.'));
        }
        else {
            const result = (0, cache_1.clearCache)();
            console.log(chalk_1.default.green(`✓ Cleared ${result.filesDeleted} cached files (${formatBytes(result.bytesFreed)} freed)`));
            console.log(chalk_1.default.gray(`  Cache directory: ${(0, cache_1.getCacheDir)()}`));
        }
        return;
    }
    const isJsonOutput = options.output === 'json';
    const isCsvOutput = options.output === 'csv';
    const showProgress = !isJsonOutput && !isCsvOutput;
    try {
        // Parse options
        const concurrency = parseInt(options.concurrency, 10);
        const topRepos = parseInt(options.topRepos, 10);
        const cacheTtlMs = parseInt(options.cacheTtl, 10) * 60 * 1000;
        const labelMappings = options.map ? (0, billing_1.parseLabelMappings)(options.map) : [];
        const useCache = options.cache;
        // Calculate date range
        let startDate;
        let endDate;
        if (options.start) {
            startDate = (0, date_fns_1.startOfDay)((0, date_fns_1.parseISO)(options.start));
            endDate = options.end ? (0, date_fns_1.startOfDay)((0, date_fns_1.parseISO)(options.end)) : new Date();
        }
        else {
            const days = parseInt(options.days, 10);
            if (isNaN(days) || days < 1) {
                console.error(chalk_1.default.red('Error: --days must be a positive number'));
                process.exit(1);
            }
            endDate = new Date();
            startDate = (0, date_fns_1.subDays)(endDate, days);
        }
        const dayCount = Math.max(1, (0, date_fns_1.differenceInDays)(endDate, startDate));
        if (showProgress) {
            console.log(chalk_1.default.bold.cyan(`\n📊 GitHub Actions Forecast`));
            console.log(chalk_1.default.gray(`   Organization: ${options.org}`));
            console.log(chalk_1.default.gray(`   Date range: ${(0, date_fns_1.format)(startDate, 'yyyy-MM-dd')} to ${(0, date_fns_1.format)(endDate, 'yyyy-MM-dd')} (${dayCount} days)`));
            if (useCache) {
                const stats = (0, cache_1.getCacheStats)();
                if (stats.files > 0) {
                    console.log(chalk_1.default.gray(`   Cache: ${stats.files} files (${formatBytes(stats.totalBytes)})`));
                }
            }
            console.log('');
        }
        // Authenticate
        if (showProgress) {
            process.stdout.write(chalk_1.default.gray('  Authenticating... '));
        }
        const auth = (0, auth_1.getAuth)(options.host);
        const octokit = (0, api_1.createOctokit)(auth);
        if (showProgress) {
            console.log(chalk_1.default.green('✓'));
        }
        // Create progress bar
        const multibar = showProgress ? new cli_progress_1.default.MultiBar({
            clearOnComplete: false,
            hideCursor: true,
            format: chalk_1.default.cyan('  {bar}') + ' | {task} | {value}/{total} | ETA: {eta_formatted}',
            barCompleteChar: '█',
            barIncompleteChar: '░',
        }, cli_progress_1.default.Presets.shades_classic) : null;
        // Step 1: Fetch repositories
        let repoBar = null;
        if (multibar) {
            repoBar = multibar.create(100, 0, { task: 'Fetching repos    ' });
        }
        const fetchOptions = { useCache, cacheTtlMs };
        const repos = await (0, api_1.listOrgRepos)(octokit, options.org, (count) => {
            repoBar?.update(Math.min(count, 100));
        }, fetchOptions);
        repoBar?.update(100);
        repoBar?.stop();
        if (repos.length === 0) {
            multibar?.stop();
            console.log(chalk_1.default.yellow('\nNo repositories found in this organization.'));
            return;
        }
        // Step 2: Fetch workflow runs with progress
        let runsBar = null;
        if (multibar) {
            runsBar = multibar.create(repos.length, 0, { task: 'Fetching runs     ' });
        }
        const startTime = Date.now();
        const runs = await (0, api_1.fetchOrgWorkflowRuns)(octokit, repos, startDate, endDate, concurrency, (completed) => {
            runsBar?.update(completed);
        }, fetchOptions);
        runsBar?.update(repos.length);
        if (runs.length === 0) {
            multibar?.stop();
            console.log(chalk_1.default.yellow('\nNo workflow runs found in the specified time period.'));
            return;
        }
        // Step 3: Fetch job details with progress
        let jobsBar = null;
        if (multibar) {
            jobsBar = multibar.create(runs.length, 0, { task: 'Fetching jobs     ' });
        }
        const jobs = await (0, api_1.fetchAllJobs)(octokit, runs, concurrency, (completed) => {
            jobsBar?.update(completed);
        }, fetchOptions);
        jobsBar?.update(runs.length);
        multibar?.stop();
        if (jobs.length === 0) {
            console.log(chalk_1.default.yellow('\nNo completed jobs found.'));
            return;
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        if (showProgress) {
            console.log(chalk_1.default.gray(`\n  Completed in ${elapsed}s: ${repos.length} repos, ${runs.length} runs, ${jobs.length} jobs\n`));
        }
        // Step 4: Calculate billing
        const billing = (0, billing_1.aggregateBilling)(jobs, labelMappings);
        // Output results
        outputResults(options.org, dayCount, startDate, endDate, billing, options.output, topRepos, options.showWorkflows, options.showJobs, options.groupBy);
    }
    catch (error) {
        if (error instanceof Error) {
            console.error(chalk_1.default.red(`\nError: ${error.message}`));
        }
        else {
            console.error(chalk_1.default.red('\nAn unexpected error occurred'));
        }
        process.exit(1);
    }
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function outputResults(org, days, startDate, endDate, billing, outputFormat, topRepos, showWorkflows = false, showJobs = false, groupBy = 'day') {
    if (outputFormat === 'json') {
        outputJSON(org, days, startDate, endDate, billing, showJobs, groupBy);
    }
    else if (outputFormat === 'csv') {
        outputCSV(billing, groupBy);
    }
    else {
        outputTable(org, days, startDate, endDate, billing, topRepos, showWorkflows, showJobs, groupBy);
    }
}
function groupByPeriod(byDate, groupBy) {
    if (groupBy === 'day') {
        return byDate;
    }
    const grouped = {};
    for (const [dateStr, data] of Object.entries(byDate)) {
        const date = (0, date_fns_1.parseISO)(dateStr);
        let periodKey;
        if (groupBy === 'week') {
            periodKey = (0, date_fns_1.format)((0, date_fns_1.startOfWeek)(date, { weekStartsOn: 1 }), 'yyyy-MM-dd');
        }
        else {
            periodKey = (0, date_fns_1.format)((0, date_fns_1.startOfMonth)(date), 'yyyy-MM');
        }
        if (!grouped[periodKey]) {
            grouped[periodKey] = { minutes: 0, billableMinutes: 0, jobCount: 0 };
        }
        grouped[periodKey].minutes += data.minutes;
        grouped[periodKey].billableMinutes += data.billableMinutes;
        grouped[periodKey].jobCount += data.jobCount;
    }
    return grouped;
}
function outputTable(org, days, startDate, endDate, billing, topRepos, showWorkflows = false, showJobs = false, groupBy = 'day') {
    const estimatedCost = (0, billing_1.estimateCost)(billing);
    const projections = (0, billing_1.projectCosts)(billing, days);
    // Header
    console.log(chalk_1.default.bold.cyan(`📊 Results for ${chalk_1.default.white(org)}`));
    console.log(chalk_1.default.gray(`   Period: ${(0, date_fns_1.format)(startDate, 'MMM d, yyyy')} - ${(0, date_fns_1.format)(endDate, 'MMM d, yyyy')}\n`));
    // Summary table
    const summaryTable = new cli_table3_1.default({
        head: [chalk_1.default.white('Metric'), chalk_1.default.white('Value')],
        style: { head: [], border: [] },
    });
    summaryTable.push(['Total Workflow Runs', billing.runCount.toLocaleString()], ['Total Jobs', billing.jobCount.toLocaleString()], ['Total Minutes', billing.totalMinutes.toLocaleString()], ['Billable Minutes (weighted)', billing.totalBillableMinutes.toLocaleString()], ['Estimated Cost (period)', chalk_1.default.green(`$${estimatedCost.toFixed(2)}`)]);
    console.log(summaryTable.toString());
    // OS breakdown
    console.log(chalk_1.default.bold('\n🖥️  Usage by Operating System:\n'));
    const osTable = new cli_table3_1.default({
        head: [
            chalk_1.default.white('OS'),
            chalk_1.default.white('Jobs'),
            chalk_1.default.white('Minutes'),
            chalk_1.default.white('Multiplier'),
            chalk_1.default.white('Billable Min'),
        ],
        style: { head: [], border: [] },
    });
    for (const [os, data] of Object.entries(billing.byOS)) {
        if (data.jobCount > 0) {
            osTable.push([
                os.charAt(0).toUpperCase() + os.slice(1),
                data.jobCount.toLocaleString(),
                data.minutes.toLocaleString(),
                `${billing_1.MULTIPLIERS[os]}x`,
                data.billableMinutes.toLocaleString(),
            ]);
        }
    }
    console.log(osTable.toString());
    // Time series breakdown
    const groupedData = groupByPeriod(billing.byDate, groupBy);
    const sortedPeriods = Object.keys(groupedData).sort();
    if (sortedPeriods.length > 1) {
        const periodLabel = groupBy === 'day' ? 'Daily' : groupBy === 'week' ? 'Weekly' : 'Monthly';
        console.log(chalk_1.default.bold(`\n📅 ${periodLabel} Breakdown:\n`));
        const periodTable = new cli_table3_1.default({
            head: [
                chalk_1.default.white(groupBy === 'month' ? 'Month' : 'Period'),
                chalk_1.default.white('Jobs'),
                chalk_1.default.white('Minutes'),
                chalk_1.default.white('Billable Min'),
            ],
            style: { head: [], border: [] },
        });
        for (const period of sortedPeriods) {
            const data = groupedData[period];
            periodTable.push([
                period,
                data.jobCount.toLocaleString(),
                data.minutes.toLocaleString(),
                data.billableMinutes.toLocaleString(),
            ]);
        }
        console.log(periodTable.toString());
    }
    // Top repositories
    const sortedRepos = Object.entries(billing.byRepo)
        .sort((a, b) => b[1].billableMinutes - a[1].billableMinutes)
        .slice(0, topRepos);
    if (sortedRepos.length > 0) {
        console.log(chalk_1.default.bold(`\n📁 Top ${Math.min(topRepos, sortedRepos.length)} Repositories by Usage:\n`));
        const repoTable = new cli_table3_1.default({
            head: [
                chalk_1.default.white('Repository'),
                chalk_1.default.white('Workflows'),
                chalk_1.default.white('Jobs'),
                chalk_1.default.white('Minutes'),
                chalk_1.default.white('Billable Min'),
            ],
            style: { head: [], border: [] },
        });
        for (const [repo, data] of sortedRepos) {
            repoTable.push([
                repo,
                data.workflows.size.toLocaleString(),
                data.jobCount.toLocaleString(),
                data.minutes.toLocaleString(),
                data.billableMinutes.toLocaleString(),
            ]);
        }
        console.log(repoTable.toString());
    }
    // Workflow breakdown (if requested)
    if (showWorkflows) {
        const sortedWorkflows = Object.entries(billing.byWorkflow)
            .sort((a, b) => b[1].billableMinutes - a[1].billableMinutes);
        if (sortedWorkflows.length > 0) {
            console.log(chalk_1.default.bold('\n⚡ Workflow Breakdown:\n'));
            const workflowTable = new cli_table3_1.default({
                head: [
                    chalk_1.default.white('Workflow'),
                    chalk_1.default.white('Runs'),
                    chalk_1.default.white('Jobs'),
                    chalk_1.default.white('Minutes'),
                    chalk_1.default.white('Billable Min'),
                ],
                style: { head: [], border: [] },
            });
            for (const [workflow, data] of sortedWorkflows) {
                workflowTable.push([
                    workflow,
                    data.runCount.toLocaleString(),
                    data.jobCount.toLocaleString(),
                    data.minutes.toLocaleString(),
                    data.billableMinutes.toLocaleString(),
                ]);
            }
            console.log(workflowTable.toString());
        }
    }
    // Job details (if requested)
    if (showJobs) {
        console.log(chalk_1.default.bold('\n🔧 Individual Job Details:\n'));
        const jobTable = new cli_table3_1.default({
            head: [
                chalk_1.default.white('Job'),
                chalk_1.default.white('Repo'),
                chalk_1.default.white('OS'),
                chalk_1.default.white('Minutes'),
                chalk_1.default.white('Billable'),
                chalk_1.default.white('Labels'),
            ],
            style: { head: [], border: [] },
            colWidths: [25, 25, 10, 10, 10, 30],
            wordWrap: true,
        });
        const sortedJobs = [...billing.jobs]
            .sort((a, b) => b.billableMinutes - a.billableMinutes)
            .slice(0, 20);
        for (const result of sortedJobs) {
            jobTable.push([
                result.job.name.substring(0, 24),
                result.job.repo_full_name,
                result.os,
                result.durationMinutes.toString(),
                result.billableMinutes.toString(),
                result.job.labels.join(', ').substring(0, 29),
            ]);
        }
        console.log(jobTable.toString());
        if (billing.jobs.length > 20) {
            console.log(chalk_1.default.gray(`   ... and ${billing.jobs.length - 20} more jobs`));
        }
    }
    // Cost projections
    console.log(chalk_1.default.bold('\n💰 Cost Projections (based on GitHub.com pricing):\n'));
    const projectionTable = new cli_table3_1.default({
        head: [chalk_1.default.white('Period'), chalk_1.default.white('Billable Min'), chalk_1.default.white('Est. Cost')],
        style: { head: [], border: [] },
    });
    const dailyMinutes = billing.totalBillableMinutes / days;
    projectionTable.push(['Daily', Math.round(dailyMinutes).toLocaleString(), chalk_1.default.green(`$${projections.daily.toFixed(2)}`)], ['Weekly', Math.round(dailyMinutes * 7).toLocaleString(), chalk_1.default.green(`$${projections.weekly.toFixed(2)}`)], ['Monthly', Math.round(dailyMinutes * 30).toLocaleString(), chalk_1.default.green(`$${projections.monthly.toFixed(2)}`)]);
    console.log(projectionTable.toString());
    // Footer
    console.log(chalk_1.default.gray('\n📝 Note: Cost estimates based on GitHub.com public pricing.'));
    console.log(chalk_1.default.gray('   Actual GHES costs may vary based on your enterprise agreement.'));
    console.log(chalk_1.default.gray('   Pricing: Linux $0.008/min, Windows $0.016/min, macOS $0.08/min'));
    console.log(chalk_1.default.gray('   Use --show-workflows and --show-jobs for detailed breakdowns.\n'));
}
function outputJSON(org, days, startDate, endDate, billing, showJobs = false, groupBy = 'day') {
    const byRepoSerialized = {};
    for (const [repo, data] of Object.entries(billing.byRepo)) {
        byRepoSerialized[repo] = {
            ...data,
            workflows: Array.from(data.workflows),
        };
    }
    const groupedData = groupByPeriod(billing.byDate, groupBy);
    const output = {
        organization: org,
        dateRange: {
            start: (0, date_fns_1.format)(startDate, 'yyyy-MM-dd'),
            end: (0, date_fns_1.format)(endDate, 'yyyy-MM-dd'),
            days,
        },
        generatedAt: new Date().toISOString(),
        summary: {
            totalRuns: billing.runCount,
            totalJobs: billing.jobCount,
            totalMinutes: billing.totalMinutes,
            totalBillableMinutes: billing.totalBillableMinutes,
            estimatedCost: (0, billing_1.estimateCost)(billing),
        },
        byOS: billing.byOS,
        byWorkflow: billing.byWorkflow,
        byRepo: byRepoSerialized,
        byPeriod: groupedData,
        projections: (0, billing_1.projectCosts)(billing, days),
    };
    if (showJobs) {
        output.jobs = billing.jobs.map((j) => ({
            name: j.job.name,
            repo: j.job.repo_full_name,
            workflow: j.job.workflow_name,
            os: j.os,
            durationMinutes: j.durationMinutes,
            billableMinutes: j.billableMinutes,
            labels: j.job.labels,
            startedAt: j.job.started_at,
            completedAt: j.job.completed_at,
        }));
    }
    console.log(JSON.stringify(output, null, 2));
}
function outputCSV(billing, groupBy = 'day') {
    const groupedData = groupByPeriod(billing.byDate, groupBy);
    console.log('period,minutes,billable_minutes,jobs');
    const sortedPeriods = Object.keys(groupedData).sort();
    for (const period of sortedPeriods) {
        const data = groupedData[period];
        console.log(`${period},${data.minutes},${data.billableMinutes},${data.jobCount}`);
    }
}
// Run the CLI
program.parse();
//# sourceMappingURL=index.js.map