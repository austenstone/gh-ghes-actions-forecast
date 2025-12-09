import { Command } from 'commander';
import chalk from 'chalk';
import cliProgress from 'cli-progress';
import Table from 'cli-table3';
import { subDays, parseISO, startOfDay, startOfWeek, startOfMonth, format, differenceInDays } from 'date-fns';
import { getAuth } from './auth';
import { createOctokit, listOrgRepos, fetchOrgWorkflowRuns, fetchAllJobs } from './api';
import {
  aggregateBilling,
  parseLabelMappings,
  estimateCost,
  projectCosts,
  MULTIPLIERS,
  AggregatedBilling,
} from './billing';
import { clearCache, getCacheStats, getCacheDir } from './cache';

const program = new Command();

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

interface CLIOptions {
  org: string;
  days: string;
  start?: string;
  end?: string;
  host?: string;
  concurrency: string;
  map?: string;
  output: 'table' | 'json' | 'csv';
  groupBy: 'day' | 'week' | 'month';
  topRepos: string;
  showWorkflows: boolean;
  showJobs: boolean;
  cache: boolean;
  clearCache: boolean;
  cacheTtl: string;
  verbose: boolean;
}

async function run(options: CLIOptions): Promise<void> {
  // Handle clear cache command
  if (options.clearCache) {
    const stats = getCacheStats();
    if (stats.files === 0) {
      console.log(chalk.yellow('Cache is already empty.'));
    } else {
      const result = clearCache();
      console.log(chalk.green(`✓ Cleared ${result.filesDeleted} cached files (${formatBytes(result.bytesFreed)} freed)`));
      console.log(chalk.gray(`  Cache directory: ${getCacheDir()}`));
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
    const labelMappings = options.map ? parseLabelMappings(options.map) : [];
    const useCache = options.cache;
    
    // Calculate date range
    let startDate: Date;
    let endDate: Date;
    
    if (options.start) {
      startDate = startOfDay(parseISO(options.start));
      endDate = options.end ? startOfDay(parseISO(options.end)) : new Date();
    } else {
      const days = parseInt(options.days, 10);
      if (isNaN(days) || days < 1) {
        console.error(chalk.red('Error: --days must be a positive number'));
        process.exit(1);
      }
      endDate = new Date();
      startDate = subDays(endDate, days);
    }
    
    const dayCount = Math.max(1, differenceInDays(endDate, startDate));
    
    if (showProgress) {
      console.log(chalk.bold.cyan(`\n📊 GitHub Actions Forecast`));
      console.log(chalk.gray(`   Organization: ${options.org}`));
      console.log(chalk.gray(`   Date range: ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')} (${dayCount} days)`));
      if (useCache) {
        const stats = getCacheStats();
        if (stats.files > 0) {
          console.log(chalk.gray(`   Cache: ${stats.files} files (${formatBytes(stats.totalBytes)})`));
        }
      }
      console.log('');
    }
    
    // Authenticate with rate limit handling
    if (showProgress) {
      process.stdout.write(chalk.gray('  Authenticating... '));
    }
    const auth = getAuth(options.host);
    const octokit = createOctokit(auth, (retryAfter, requestOptions) => {
      if (showProgress) {
        console.log(chalk.yellow(`\n  ⚠️  Rate limited. Retrying in ${retryAfter}s...`));
      }
    });
    if (showProgress) {
      console.log(chalk.green('✓'));
    }
    
    // Create progress bar
    const multibar = showProgress ? new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: chalk.cyan('  {bar}') + ' | {task} | {value}/{total} | ETA: {eta_formatted}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
    }, cliProgress.Presets.shades_classic) : null;
    
    // Step 1: Fetch repositories
    let repoBar: cliProgress.SingleBar | null = null;
    if (multibar) {
      repoBar = multibar.create(1, 0, { task: 'Fetching repos    ' });
    }
    
    const fetchOptions = { useCache, cacheTtlMs };
    const repos = await listOrgRepos(octokit, options.org, (count) => {
      // Update total dynamically as we discover repos
      repoBar?.setTotal(count);
      repoBar?.update(count);
    }, fetchOptions);
    
    repoBar?.setTotal(repos.length);
    repoBar?.update(repos.length);
    repoBar?.stop();
    
    if (repos.length === 0) {
      multibar?.stop();
      console.log(chalk.yellow('\nNo repositories found in this organization.'));
      return;
    }
    
    // Step 2: Fetch workflow runs with progress
    let runsBar: cliProgress.SingleBar | null = null;
    if (multibar) {
      runsBar = multibar.create(repos.length, 0, { task: 'Fetching runs     ' });
    }
    
    const startTime = Date.now();
    
    const runs = await fetchOrgWorkflowRuns(
      octokit,
      repos,
      startDate,
      endDate,
      concurrency,
      (completed) => {
        runsBar?.update(completed);
      },
      fetchOptions
    );
    
    runsBar?.update(repos.length);
    
    if (runs.length === 0) {
      multibar?.stop();
      console.log(chalk.yellow('\nNo workflow runs found in the specified time period.'));
      return;
    }
    
    // Step 3: Fetch job details with progress
    let jobsBar: cliProgress.SingleBar | null = null;
    if (multibar) {
      jobsBar = multibar.create(runs.length, 0, { task: 'Fetching jobs     ' });
    }
    
    const jobs = await fetchAllJobs(octokit, runs, concurrency, (completed) => {
      jobsBar?.update(completed);
    }, fetchOptions);
    
    jobsBar?.update(runs.length);
    multibar?.stop();
    
    if (jobs.length === 0) {
      console.log(chalk.yellow('\nNo completed jobs found.'));
      return;
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (showProgress) {
      console.log(chalk.gray(`\n  Completed in ${elapsed}s: ${repos.length} repos, ${runs.length} runs, ${jobs.length} jobs\n`));
    }
    
    // Step 4: Calculate billing
    const billing = aggregateBilling(jobs, labelMappings);
    
    // Output results
    outputResults(options.org, dayCount, startDate, endDate, billing, options.output, topRepos, 
                  options.showWorkflows, options.showJobs, options.groupBy);
    
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\nError: ${error.message}`));
      if (error.stack) {
        console.error(chalk.gray(error.stack));
      }
    } else {
      console.error(chalk.red('\nAn unexpected error occurred'));
      console.error(error);
    }
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function outputResults(
  org: string,
  days: number,
  startDate: Date,
  endDate: Date,
  billing: AggregatedBilling,
  outputFormat: 'table' | 'json' | 'csv',
  topRepos: number,
  showWorkflows: boolean = false,
  showJobs: boolean = false,
  groupBy: 'day' | 'week' | 'month' = 'day'
): void {
  if (outputFormat === 'json') {
    outputJSON(org, days, startDate, endDate, billing, showJobs, groupBy);
  } else if (outputFormat === 'csv') {
    outputCSV(billing, groupBy);
  } else {
    outputTable(org, days, startDate, endDate, billing, topRepos, showWorkflows, showJobs, groupBy);
  }
}

function groupByPeriod(
  byDate: Record<string, { minutes: number; billableMinutes: number; jobCount: number }>,
  groupBy: 'day' | 'week' | 'month'
): Record<string, { minutes: number; billableMinutes: number; jobCount: number }> {
  if (groupBy === 'day') {
    return byDate;
  }
  
  const grouped: Record<string, { minutes: number; billableMinutes: number; jobCount: number }> = {};
  
  for (const [dateStr, data] of Object.entries(byDate)) {
    const date = parseISO(dateStr);
    let periodKey: string;
    
    if (groupBy === 'week') {
      periodKey = format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    } else {
      periodKey = format(startOfMonth(date), 'yyyy-MM');
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

function outputTable(
  org: string,
  days: number,
  startDate: Date,
  endDate: Date,
  billing: AggregatedBilling,
  topRepos: number,
  showWorkflows: boolean = false,
  showJobs: boolean = false,
  groupBy: 'day' | 'week' | 'month' = 'day'
): void {
  const estimatedCost = estimateCost(billing);
  const projections = projectCosts(billing, days);
  
  // Header
  console.log(chalk.bold.cyan(`📊 Results for ${chalk.white(org)}`));
  console.log(chalk.gray(`   Period: ${format(startDate, 'MMM d, yyyy')} - ${format(endDate, 'MMM d, yyyy')}\n`));
  
  // Summary table
  const summaryTable = new Table({
    head: [chalk.white('Metric'), chalk.white('Value')],
    style: { head: [], border: [] },
  });
  
  summaryTable.push(
    ['Total Workflow Runs', billing.runCount.toLocaleString()],
    ['Total Jobs', billing.jobCount.toLocaleString()],
    ['Total Minutes', billing.totalMinutes.toLocaleString()],
    ['Billable Minutes (weighted)', billing.totalBillableMinutes.toLocaleString()],
    ['Estimated Cost (period)', chalk.green(`$${estimatedCost.toFixed(2)}`)],
  );
  
  console.log(summaryTable.toString());
  
  // OS breakdown
  console.log(chalk.bold('\n🖥️  Usage by Operating System:\n'));
  
  const osTable = new Table({
    head: [
      chalk.white('OS'),
      chalk.white('Jobs'),
      chalk.white('Minutes'),
      chalk.white('Multiplier'),
      chalk.white('Billable Min'),
    ],
    style: { head: [], border: [] },
  });
  
  for (const [os, data] of Object.entries(billing.byOS)) {
    if (data.jobCount > 0) {
      osTable.push([
        os.charAt(0).toUpperCase() + os.slice(1),
        data.jobCount.toLocaleString(),
        data.minutes.toLocaleString(),
        `${MULTIPLIERS[os as keyof typeof MULTIPLIERS]}x`,
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
    console.log(chalk.bold(`\n📅 ${periodLabel} Breakdown:\n`));
    
    const periodTable = new Table({
      head: [
        chalk.white(groupBy === 'month' ? 'Month' : 'Period'),
        chalk.white('Jobs'),
        chalk.white('Minutes'),
        chalk.white('Billable Min'),
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
    console.log(chalk.bold(`\n📁 Top ${Math.min(topRepos, sortedRepos.length)} Repositories by Usage:\n`));
    
    const repoTable = new Table({
      head: [
        chalk.white('Repository'),
        chalk.white('Workflows'),
        chalk.white('Jobs'),
        chalk.white('Minutes'),
        chalk.white('Billable Min'),
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
      console.log(chalk.bold('\n⚡ Workflow Breakdown:\n'));
      
      const workflowTable = new Table({
        head: [
          chalk.white('Workflow'),
          chalk.white('Runs'),
          chalk.white('Jobs'),
          chalk.white('Minutes'),
          chalk.white('Billable Min'),
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
    console.log(chalk.bold('\n🔧 Individual Job Details:\n'));
    
    const jobTable = new Table({
      head: [
        chalk.white('Job'),
        chalk.white('Repo'),
        chalk.white('OS'),
        chalk.white('Minutes'),
        chalk.white('Billable'),
        chalk.white('Labels'),
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
      console.log(chalk.gray(`   ... and ${billing.jobs.length - 20} more jobs`));
    }
  }
  
  // Cost projections
  console.log(chalk.bold('\n💰 Cost Projections (based on GitHub.com pricing):\n'));
  
  const projectionTable = new Table({
    head: [chalk.white('Period'), chalk.white('Billable Min'), chalk.white('Est. Cost')],
    style: { head: [], border: [] },
  });
  
  const dailyMinutes = billing.totalBillableMinutes / days;
  
  projectionTable.push(
    ['Daily', Math.round(dailyMinutes).toLocaleString(), chalk.green(`$${projections.daily.toFixed(2)}`)],
    ['Weekly', Math.round(dailyMinutes * 7).toLocaleString(), chalk.green(`$${projections.weekly.toFixed(2)}`)],
    ['Monthly', Math.round(dailyMinutes * 30).toLocaleString(), chalk.green(`$${projections.monthly.toFixed(2)}`)],
  );
  
  console.log(projectionTable.toString());
  
  // Footer
  console.log(chalk.gray('\n📝 Note: Cost estimates based on GitHub.com public pricing.'));
  console.log(chalk.gray('   Actual GHES costs may vary based on your enterprise agreement.'));
  console.log(chalk.gray('   Pricing: Linux $0.008/min, Windows $0.016/min, macOS $0.08/min'));
  console.log(chalk.gray('   Use --show-workflows and --show-jobs for detailed breakdowns.\n'));
}

function outputJSON(
  org: string,
  days: number,
  startDate: Date,
  endDate: Date,
  billing: AggregatedBilling,
  showJobs: boolean = false,
  groupBy: 'day' | 'week' | 'month' = 'day'
): void {
  const byRepoSerialized: Record<string, { minutes: number; billableMinutes: number; jobCount: number; workflows: string[] }> = {};
  for (const [repo, data] of Object.entries(billing.byRepo)) {
    byRepoSerialized[repo] = {
      ...data,
      workflows: Array.from(data.workflows),
    };
  }
  
  const groupedData = groupByPeriod(billing.byDate, groupBy);
  
  const output: Record<string, unknown> = {
    organization: org,
    dateRange: {
      start: format(startDate, 'yyyy-MM-dd'),
      end: format(endDate, 'yyyy-MM-dd'),
      days,
    },
    generatedAt: new Date().toISOString(),
    summary: {
      totalRuns: billing.runCount,
      totalJobs: billing.jobCount,
      totalMinutes: billing.totalMinutes,
      totalBillableMinutes: billing.totalBillableMinutes,
      estimatedCost: estimateCost(billing),
    },
    byOS: billing.byOS,
    byWorkflow: billing.byWorkflow,
    byRepo: byRepoSerialized,
    byPeriod: groupedData,
    projections: projectCosts(billing, days),
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

function outputCSV(
  billing: AggregatedBilling,
  groupBy: 'day' | 'week' | 'month' = 'day'
): void {
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
