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
    // Use --format=%B to get full commit message (including body for multiline commits)
    // Use --pretty=format: to ensure proper separation between commits
    const { stdout } = await execa('git', [
      'log',
      `--author=${author}`,
      `--since="${dateRange.start}"`,
      `--until="${dateRange.end}"`,
      '--pretty=format:%H%n%s%n%b%n---COMMIT_SEPARATOR---%n',
      '--no-merges'
    ], { cwd: repoPath });

    if (!stdout.trim()) {
      return [];
    }

    // Split commits by separator and parse each one
    const commitBlocks = stdout.trim().split('---COMMIT_SEPARATOR---\n').filter(block => block.trim());

    const commits = [];
    for (const block of commitBlocks) {
      const lines = block.trim().split('\n');
      if (lines.length >= 2) {
        const hash = lines[0];
        const subject = lines[1];
        const body = lines.slice(2).join('\n').trim();

        // Combine subject and body for multiline commits
        const fullMessage = body ? `${subject}\n\n${body}` : subject;
        commits.push(fullMessage);
      }
    }

    return commits;
  } catch (error) {
    if (error.stderr && error.stderr.includes('fatal: not a git repository')) {
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

  const commitsText = commits.join('\n\n---\n\n');
  const jiraTickets = extractJiraTickets(commits);

  let systemPrompt = `You are an expert project manager. Your task is to convert a list of raw Git commit messages from a developer into a concise, high-level summary. This summary will be read during a daily stand-up meeting to a non-technical audience. Focus on the impact and progress rather than the technical details. Group related changes into a single point. Start the summary with 'Yesterday, I...' and use bullet points for the key activities. Keep it brief and business-focused.`;

  if (jiraTickets.length > 0) {
    systemPrompt += ` Also mention any Jira tickets referenced in the commits.`;
  }

  const userPrompt = `Please summarize these Git commit messages:\n\n${commitsText}`;

  try {
    const result = await model.generateContent([
      { text: systemPrompt },
      { text: userPrompt }
    ]);

    const response = await result.response;
    let summary = response.text().trim();

    // Add Jira tickets to the summary if not already included
    if (jiraTickets.length > 0 && !summary.includes(jiraTickets[0])) {
      summary += `\n\nJira Tickets: ${jiraTickets.join(', ')}`;
    }

    return summary;
  } catch (error) {
    throw new Error(`Failed to generate summary: ${error.message}`);
  }
}

function extractJiraTickets(commits) {
  const jiraPattern = /\b([A-Z]+-\d+)\b/g;
  const tickets = new Set();

  for (const commit of commits) {
    const matches = commit.match(jiraPattern);
    if (matches) {
      matches.forEach(ticket => tickets.add(ticket));
    }
  }

  return Array.from(tickets).sort();
}

function generateDemoSummary(commits) {
  const summaryPoints = [];
  const jiraTickets = extractJiraTickets(commits);

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

  let summary = `Yesterday, I...\n${uniquePoints.map(point => `- ${point}`).join('\n')}`;

  // Add Jira tickets if found
  if (jiraTickets.length > 0) {
    summary += `\n\nJira Tickets: ${jiraTickets.join(', ')}`;
  }

  return summary;
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

    // Extract Jira tickets
    const jiraTickets = extractJiraTickets(commits);
    if (jiraTickets.length > 0) {
      console.log(`🎫 Jira Tickets: ${jiraTickets.join(', ')}`);
    }

    if (options.verbose) {
      console.log('\n📋 Raw commits:');
      commits.forEach((commit, index) => {
        const lines = commit.split('\n');
        console.log(`${index + 1}. ${lines[0]}`); // Show subject line
        if (lines.length > 1) {
          // Filter out any separator artifacts and show body with indentation
          const bodyLines = lines.slice(1).filter(line => !line.includes('---COMMIT_SEPARATOR---'));
          if (bodyLines.length > 0) {
            console.log(`   ${bodyLines.join('\n   ')}`); // Show body with indentation
          }
        }
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
    if (jiraTickets.length > 0) {
      console.log(`\n🎫 Related Jira Tickets: ${jiraTickets.join(', ')}`);
    }
    console.log('='.repeat(50));

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
