#!/usr/bin/env node

import { Command } from 'commander';
import { execa } from 'execa';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { format, subDays, isWeekend, previousFriday, startOfDay, endOfDay } from 'date-fns';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));

const program = new Command();

program
  .name('aistand')
  .description('A CLI tool to summarize your Git commits for daily stand-ups.')
  .version(packageJson.version, '-v, --version', 'output the version number')
  .option('-d, --date <date>', 'Specify a particular date (YYYY-MM-DD) instead of previous workday')
  .option('-p, --path <path>', 'Path to Git repository (defaults to current directory)')
  .option('--verbose', 'Show raw commit messages before summary')
  .option('-k, --api-key <key>', 'Gemini API key (can also be set as GEMINI_API_KEY env var)')
  .option('--demo', 'Force demo mode (ignore API key)');

program.parse(process.argv);

const options = program.opts();

// Get Gemini API key
const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
const demoMode = options.demo || !apiKey || apiKey.trim() === '';

if (demoMode) {
  console.log('🚀 Running in demo mode (no API key provided)');
  console.log('💡 To use AI summarization, set GEMINI_API_KEY environment variable or use --api-key\n');
}

// Initialize Gemini AI (only if API key is available)
// Logic moved to generateSummaryWithRetry to allow dynamic model selection

async function getAvailableModels(apiKey) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) {
      // If listing fails, return a default fallback list
      return ['models/gemini-2.0-flash-exp', 'models/gemini-1.5-flash'];
    }
    const data = await response.json();
    if (!data.models) return [];

    // Filter for models that generate content and prefer flash/recent models
    const supportedModels = data.models
      .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name);

    // Sort to prioritize models ending in "-flash", then other flash variants
    return supportedModels.sort((a, b) => {
      const getScore = (name) => {
        if (name.endsWith('-flash')) return 10;
        if (name.includes('gemini-2.0-flash')) return 3;
        if (name.includes('gemini-1.5-flash')) return 2;
        if (name.includes('gemini-1.5-pro')) return 1;
        return 0;
      };
      return getScore(b) - getScore(a);
    });
  } catch (error) {
    // Fallback if fetch fails
    return ['models/gemini-2.0-flash-exp', 'models/gemini-1.5-flash'];
  }
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
  const today = new Date();
  let startDate, endDate;

  if (targetDate) {
    // If specific date provided, use that date only
    const date = new Date(targetDate);
    startDate = startOfDay(date);
    endDate = endOfDay(date);
  } else {
    // Include both previous workday and today
    let previousWorkday = subDays(today, 1); // Yesterday

    // If yesterday was a weekend, get Friday
    if (isWeekend(previousWorkday)) {
      previousWorkday = previousFriday(previousWorkday);
    }

    // Start from previous workday, end at end of today
    startDate = startOfDay(previousWorkday);
    endDate = endOfDay(today);
  }

  return {
    start: format(startDate, 'yyyy-MM-dd HH:mm:ss'),
    end: format(endDate, 'yyyy-MM-dd HH:mm:ss'),
    displayDate: targetDate ? format(new Date(targetDate), 'yyyy-MM-dd') : `${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}`
  };
}

function getDateRelativeText(commits) {
  if (commits.length === 0) return 'Recently, I';

  // Get the commit dates to determine the appropriate prefix
  const today = format(new Date(), 'yyyy-MM-dd');
  const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
  
  // Check if we have commits from multiple days
  const hasToday = commits.some(commit => commit.date === today);
  const hasYesterday = commits.some(commit => commit.date === yesterday);
  
  if (hasToday && hasYesterday) {
    return 'Recently, I';
  } else if (hasToday) {
    return 'Today, I';
  } else {
    // Determine the day name for the commits
    const commitDate = new Date(commits[0].date);
    const daysDiff = Math.floor((new Date() - commitDate) / (1000 * 60 * 60 * 24));
    
    if (daysDiff === 1) {
      return 'Yesterday, I';
    } else if (daysDiff <= 7) {
      const dayName = format(commitDate, 'EEEE'); // Monday, Tuesday, etc.
      return `On ${dayName}, I`;
    } else {
      return 'Recently, I';
    }
  }
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
      '--pretty=format:%H%n%ad%n%s%n%b%n---COMMIT_SEPARATOR---%n',
      '--date=short',
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
      if (lines.length >= 3) {
        const hash = lines[0];
        const date = lines[1];
        const subject = lines[2];
        const body = lines.slice(3).join('\n').trim();

        // Combine subject and body for multiline commits
        const fullMessage = body ? `${subject}\n\n${body}` : subject;
        commits.push({ message: fullMessage, date, hash });
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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateSummary(commits) {
  if (commits.length === 0) {
    return 'No commits found for the specified period.';
  }

  if (demoMode) {
    return generateDemoSummary(commits);
  }

  // Get available models
  let availableModels = await getAvailableModels(apiKey);
  if (availableModels.length === 0) {
     // Hard fallback if API listing fails completely
     availableModels = ['models/gemini-2.0-flash-exp', 'models/gemini-1.5-flash'];
  }
  
  // Ensure we try at least a few models
  const maxRetries = 3;
  let lastError = null;

  for (const modelName of availableModels) {
    // Clean model name for SDK (SDK usually expects 'gemini-pro', API returns 'models/gemini-pro')
    const cleanModelName = modelName.startsWith('models/') ? modelName.replace('models/', '') : modelName;
    
    // We try each model up to maxRetries times with backoff
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: cleanModelName });

        const commitsText = commits.map(c => typeof c === 'string' ? c : c.message).join('\n\n---\n\n');
        const jiraTickets = extractJiraTickets(commits);
        const datePrefix = getDateRelativeText(commits);

        let systemPrompt = `You are an expert project manager. Your task is to convert a list of raw Git commit messages from a developer into a concise, high-level summary. This summary will be read during a daily stand-up meeting to a non-technical audience. Focus on the impact and progress rather than the technical details. Group related changes into a single point. Start the summary with '${datePrefix}...' and use bullet points for the key activities. Keep it brief and business-focused.`;

        if (jiraTickets.length > 0) {
          systemPrompt += ` Also mention any Jira tickets referenced in the commits.`;
        }

        const userPrompt = `Please summarize these Git commit messages:\n\n${commitsText}`;

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
        
        // Log successful model usage
        console.log(`\n🧠 Model: ${cleanModelName}`);

        return summary;

      } catch (error) {
        lastError = error;
        const isQuotaError = error.message.includes('429') || error.message.includes('Quota exceeded') || error.status === 429;
        
        if (isQuotaError) {
             const delay = attempt * 1200;
             console.log(`⚠️ AI request failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
             await sleep(delay);
             // Verify if we should fallback to next model immediately for 429? 
             // Logic in logs suggests it retries same model a few times then switches.
             if (attempt === maxRetries) {
                 console.log(`⚠️ Model ${cleanModelName} is unavailable (${error.message}). Trying next model...`);
             }
        } else {
            // Non-quota error, maybe try next model immediately
            console.log(`⚠️ Model ${cleanModelName} error: ${error.message}. Trying next model...`);
            break; // Break inner loop to try next model
        }
      }
    }
  }

  throw new Error(`Failed to generate summary after trying multiple models. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
}

function extractJiraTickets(commits) {
  const jiraPattern = /\b([A-Z]+-\d+)\b/g;
  const tickets = new Set();

  for (const commit of commits) {
    const message = typeof commit === 'string' ? commit : commit.message;
    const matches = message.match(jiraPattern);
    if (matches) {
      matches.forEach(ticket => tickets.add(ticket));
    }
  }

  return Array.from(tickets).sort();
}

function generateDemoSummary(commits) {
  const summaryPoints = [];
  const jiraTickets = extractJiraTickets(commits);
  const datePrefix = getDateRelativeText(commits);

  for (const commit of commits) {
    const message = typeof commit === 'string' ? commit : commit.message;
    if (message.toLowerCase().includes('feat')) {
      summaryPoints.push('Implemented new features and functionality');
    } else if (message.toLowerCase().includes('fix')) {
      summaryPoints.push('Fixed bugs and resolved issues');
    } else if (message.toLowerCase().includes('refactor')) {
      summaryPoints.push('Improved code structure and performance');
    } else if (message.toLowerCase().includes('chore')) {
      summaryPoints.push('Updated dependencies and maintenance tasks');
    } else {
      summaryPoints.push('Made various improvements to the codebase');
    }
  }

  // Remove duplicates and format
  const uniquePoints = [...new Set(summaryPoints)];

  let summary = `${datePrefix}...\n${uniquePoints.map(point => `- ${point}`).join('\n')}`;

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

    if (options.verbose || demoMode) {
      console.log('\n📋 Raw commits:');
      commits.forEach((commit, index) => {
        const message = typeof commit === 'string' ? commit : commit.message;
        const date = typeof commit === 'object' ? commit.date : '';
        const lines = message.split('\n');
        console.log(`${index + 1}. ${lines[0]} ${date ? `(${date})` : ''}`); // Show subject line with date
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

    if (!demoMode) {
      console.log('🤖 Generating AI summary...');

      // Generate summary
      const summary = await generateSummary(commits);

      console.log('\n' + '='.repeat(50));
      console.log('📊 STAND-UP SUMMARY');
      console.log('='.repeat(50));
      console.log(summary);
      if (jiraTickets.length > 0 && !summary.includes('Related Jira Tickets')) {
         // Check if summary already has it, logic inside generateSummary adds it
         // but just to be sure we match original output format
         // Actually generateSummary returns the whole text. 
         // The original code had separate log for tickets if not in summary.
         // Let's rely on generateSummary to include it or not.
      }
      console.log('='.repeat(50));
    }

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
