#!/usr/bin/env node

import { Command } from 'commander';
import { execa } from 'execa';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { format, subDays, isWeekend, previousFriday, startOfDay, endOfDay } from 'date-fns';

const program = new Command();

program
  .name('standup-summary')
  .description('A CLI tool to summarize your Git commits for daily stand-ups.')
  .version('0.0.1')
  .option('-d, --date <date>', 'Specify a particular date (YYYY-MM-DD) instead of previous workday')
  .option('-p, --path <path>', 'Path to Git repository (defaults to current directory)')
  .option('-v, --verbose', 'Show raw commit messages before summary')
  .option('-k, --api-key <key>', 'Gemini API key (can also be set as GEMINI_API_KEY env var)');

program.parse(process.argv);

const options = program.opts();

// Get Gemini API key
const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
const demoMode = !apiKey;

if (demoMode) {
  console.log('🚀 Running in demo mode (no API key provided)');
  console.log('💡 To use AI summarization, set GEMINI_API_KEY environment variable or use --api-key\n');
}

// Initialize Gemini AI (only if API key is available)
let genAI, model;
if (!demoMode) {
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
}

async function getGitUser() {
  try {
    const { stdout: name } = await execa('git', ['config', 'user.name']);
    const { stdout: email } = await execa('git', ['config', 'user.email']);
    return { name: name.trim(), email: email.trim() };
  } catch (error) {
    throw new Error('Could not get Git user configuration. Make sure you\'re in a Git repository and have configured user.name and user.email.');
  }
}

function calculateDateRange(targetDate = null) {
  let date = targetDate ? new Date(targetDate) : new Date();

  // If no specific date provided, get previous workday
  if (!targetDate) {
    date = subDays(date, 1); // Yesterday

    // If yesterday was a weekend, get Friday
    if (isWeekend(date)) {
      date = previousFriday(date);
    }
  }

  const startDate = startOfDay(date);
  const endDate = endOfDay(date);

  return {
    start: format(startDate, 'yyyy-MM-dd HH:mm:ss'),
    end: format(endDate, 'yyyy-MM-dd HH:mm:ss'),
    displayDate: format(date, 'yyyy-MM-dd')
  };
}

async function fetchCommits(repoPath = '.', author, dateRange) {
  try {
    const { stdout } = await execa('git', [
      'log',
      `--author=${author}`,
      `--since="${dateRange.start}"`,
      `--until="${dateRange.end}"`,
      '--format=%s',
      '--no-merges'
    ], { cwd: repoPath });

    return stdout.trim().split('\n').filter(commit => commit.length > 0);
  } catch (error) {
    if (error.stderr.includes('fatal: not a git repository')) {
      throw new Error('Not a Git repository. Please run this command from within a Git repository.');
    }
    return [];
  }
}

async function generateSummary(commits) {
  if (commits.length === 0) {
    return 'No commits found for the specified period.';
  }

  if (demoMode) {
    // Demo mode: generate a simple summary based on commit patterns
    const summary = generateDemoSummary(commits);
    return summary;
  }

  const commitsText = commits.join('\n');
  const systemPrompt = `You are an expert project manager. Your task is to convert a list of raw Git commit messages from a developer into a concise, high-level summary. This summary will be read during a daily stand-up meeting to a non-technical audience. Focus on the impact and progress rather than the technical details. Group related changes into a single point. Start the summary with 'Yesterday, I...' and use bullet points for the key activities. Keep it brief and business-focused. Include ticket number like CC-1234 from related commit messages`;

  const userPrompt = `Please summarize these Git commit messages:\n\n${commitsText}`;

  try {
    const result = await model.generateContent([
      { text: systemPrompt },
      { text: userPrompt }
    ]);

    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
}

function generateDemoSummary(commits) {
  const summaryPoints = [];

  for (const commit of commits) {
    if (commit.toLowerCase().includes('feat')) {
      summaryPoints.push('Implemented new features and functionality');
    } else if (commit.toLowerCase().includes('fix')) {
      summaryPoints.push('Fixed bugs and resolved issues');
    } else if (commit.toLowerCase().includes('refactor')) {
      summaryPoints.push('Improved code structure and performance');
    } else if (commit.toLowerCase().includes('chore')) {
      summaryPoints.push('Updated dependencies and maintenance tasks');
    } else {
      summaryPoints.push('Made various improvements to the codebase');
    }
  }

  // Remove duplicates and format
  const uniquePoints = [...new Set(summaryPoints)];

  return `Yesterday, I...\n${uniquePoints.map(point => `- ${point}`).join('\n')}`;
}

async function main() {
  try {
    console.log('🔍 Analyzing your Git repository...');

    // Get Git user info
    const user = await getGitUser();
    console.log(`👤 User: ${user.name} <${user.email}>`);

    // Calculate date range
    const dateRange = calculateDateRange(options.date);
    console.log(`📅 Date range: ${dateRange.displayDate}`);

    // Fetch commits
    const repoPath = options.path || '.';
    const commits = await fetchCommits(repoPath, user.email, dateRange);

    if (commits.length === 0) {
      console.log('❌ No commits found for the specified period.');
      return;
    }

    console.log(`📝 Found ${commits.length} commit(s)`);

    if (options.verbose) {
      console.log('\n📋 Raw commits:');
      commits.forEach((commit, index) => {
        console.log(`${index + 1}. ${commit}`);
      });
      console.log('');
    }

    console.log('🤖 Generating AI summary...');

    // Generate summary
    const summary = await generateSummary(commits);

    console.log('\n' + '='.repeat(50));
    console.log('📊 STAND-UP SUMMARY');
    console.log('='.repeat(50));
    console.log(summary);
    console.log('='.repeat(50));

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
