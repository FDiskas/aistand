#!/usr/bin/env node

import { Command } from 'commander';
import { execa } from 'execa';
import { GoogleGenAI } from '@google/genai';
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
  .option('-k, --api-key <key>', 'Gemini API key (set GEMINI_API_KEY or GOOGLE_API_KEY env vars)')
  .option('--recent-branches <count>', 'Also scan N most recently updated local branches in addition to the current branch (use 0 to disable)', value => parseInt(value, 10))
  .option('--model <name>', 'Override Gemini model (defaults to best available flash variant)')
  .option('--demo', 'Force demo mode (ignore API key)');

program.parse(process.argv);

const options = program.opts();

// Get Gemini API key
const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const demoMode = options.demo || !apiKey || apiKey.trim() === '';
const DEFAULT_RECENT_BRANCHES = 3;
const envRecentBranchesRaw = process.env.AISTAND_RECENT_BRANCHES;
const envRecentBranches = envRecentBranchesRaw !== undefined ? parseInt(envRecentBranchesRaw, 10) : undefined;
const requestedRecentBranches = options.recentBranches ?? envRecentBranches ?? DEFAULT_RECENT_BRANCHES;
const recentBranchesCount = Number.isFinite(requestedRecentBranches)
  ? Math.max(0, Math.floor(requestedRecentBranches))
  : DEFAULT_RECENT_BRANCHES;
const requestedModel = options.model || process.env.GEMINI_MODEL;
const MAX_AI_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1200;

if (demoMode) {
  console.log('🚀 Running in demo mode (no API key provided)');
  console.log('💡 To use AI summarization, set GEMINI_API_KEY environment variable or use --api-key\n');
}

// Initialize Gemini AI (only if API key is available)
let aiClient;
if (!demoMode) {
  aiClient = new GoogleGenAI({ apiKey });
}

let availableModelInfoPromise;
let resolvedModelPreferencePromise;
let modelListingWarningLogged = false;

async function getGitUser() {
  try {
    const { stdout: name } = await execa('git', ['config', 'user.name']);
    const { stdout: email } = await execa('git', ['config', 'user.email']);
    return { name: name.trim(), email: email.trim() };
  } catch (error) {
    throw new Error('Could not get Git user configuration. Make sure you\'re in a Git repository and have configured user.name and user.email.');
  }
}

async function getCurrentBranch(repoPath = '.') {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    return stdout.trim();
  } catch (error) {
    if (error.stderr && error.stderr.includes('not a git repository')) {
      throw new Error('Not a Git repository. Please run this command from within a Git repository.');
    }
    throw new Error('Could not determine the current Git branch.');
  }
}

async function getRecentLocalBranches(repoPath = '.', excludeBranch, limit = 0) {
  if (!limit || limit <= 0) {
    return [];
  }

  try {
    const { stdout } = await execa('git', [
      'for-each-ref',
      '--format=%(refname:short)|%(committerdate:unix)',
      '--sort=-committerdate',
      'refs/heads'
    ], { cwd: repoPath });

    if (!stdout.trim()) {
      return [];
    }

    return stdout
      .trim()
      .split('\n')
      .map(line => line.split('|')[0])
      .filter(branch => branch && branch !== excludeBranch)
      .slice(0, limit);
  } catch (error) {
    console.warn('⚠️ Unable to list recent branches. Falling back to current branch only.');
    return [];
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

function simplifyModelName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('/');
  return segments[segments.length - 1];
}

async function getAvailableModelInfo() {
  if (!aiClient) return null;
  if (!availableModelInfoPromise) {
    availableModelInfoPromise = loadAvailableModelInfo();
  }
  return availableModelInfoPromise;
}

async function loadAvailableModelInfo() {
  if (!aiClient) return null;
  try {
    const pager = await aiClient.models.list({
      config: {
        pageSize: 50,
        queryBase: true
      }
    });
    const simpleNames = new Set();
    for await (const model of pager) {
      const simplified = simplifyModelName(model?.name);
      if (simplified) {
        simpleNames.add(simplified);
      }
    }
    return { simpleNames };
  } catch (error) {
    if (!modelListingWarningLogged) {
      console.warn('⚠️ Unable to fetch model metadata automatically. Falling back to static preference.');
      modelListingWarningLogged = true;
    }
    return null;
  }
}

function buildDynamicModelPreference(simpleNames) {
  if (!simpleNames || simpleNames.size === 0) {
    return [];
  }
  const flashModels = Array.from(simpleNames).filter(name => {
    if (!name) return false;
    const lower = name.toLowerCase();
    if (!lower.includes('gemini') || !lower.includes('flash')) return false;
    return !isExperimentalModel(lower);
  });
  flashModels.sort((a, b) => scoreModelName(b) - scoreModelName(a));
  return flashModels;
}

function isExperimentalModel(lowerName) {
  return lowerName.includes('exp') || lowerName.includes('preview') || lowerName.includes('beta');
}

function extractVersion(name) {
  const match = name.match(/gemini-(\d+(?:\.\d+)?)/i);
  return match ? parseFloat(match[1]) : 0;
}

function scoreModelName(name) {
  const lower = name.toLowerCase();
  let score = 0;

  // Primary tiers
  if (lower.endsWith('-flash')) score += 10000;
  else if (lower.includes('flash')) score += 5000;

  // Version priority (e.g. 2.5 -> 2500, 1.5 -> 1500)
  const version = extractVersion(lower);
  score += version * 1000;

  // Minor adjustments
  if (lower.includes('latest')) score += 10;
  if (isExperimentalModel(lower)) score -= 30;
  if (lower.includes('8b') || lower.includes('lite') || lower.includes('mini')) score -= 50;
  if (lower.includes('pro')) score -= 100; // De-prioritize pro if we want flash

  return score;
}

function dedupeModelList(list) {
  const result = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

async function getResolvedModelPreference() {
  if (resolvedModelPreferencePromise) {
    return resolvedModelPreferencePromise;
  }

  resolvedModelPreferencePromise = (async () => {
    if (requestedModel) {
      return [requestedModel];
    }

    const modelInfo = await getAvailableModelInfo();
    if (!modelInfo || !modelInfo.simpleNames || modelInfo.simpleNames.size === 0) {
      return []; // Caller will handle empty list
    }

    const dynamicList = buildDynamicModelPreference(modelInfo.simpleNames);
    const combined = dedupeModelList([...dynamicList]); // No static fallback
    return combined;
  })();

  return resolvedModelPreferencePromise;
}

async function fetchCommits(repoPath = '.', author, dateRange, branches = []) {
  try {
    const branchesToScan = (branches && branches.length > 0) ? branches : ['HEAD'];
    const commitsByHash = new Map();

    for (const branch of branchesToScan) {
      const args = [
        'log',
        branch,
        `--author=${author}`,
        `--since=${dateRange.start}`,
        `--until=${dateRange.end}`,
        '--pretty=format:%H%n%ad%n%s%n%b%n---COMMIT_SEPARATOR---%n',
        '--date=short',
        '--no-merges'
      ];

      let stdout;
      try {
        ({ stdout } = await execa('git', args, { cwd: repoPath }));
      } catch (branchError) {
        if (branchError.stderr && branchError.stderr.includes('unknown revision or path')) {
          console.warn(`⚠️ Branch ${branch} not found. Skipping.`);
          continue;
        }
        throw branchError;
      }

      if (!stdout.trim()) {
        continue;
      }

      const commitBlocks = stdout.trim().split('---COMMIT_SEPARATOR---\n').filter(block => block.trim());
      for (const block of commitBlocks) {
        const lines = block.trim().split('\n');
        if (lines.length >= 3) {
          const hash = lines[0];
          const date = lines[1];
          const subject = lines[2];
          const body = lines.slice(3).join('\n').trim();
          const fullMessage = body ? `${subject}\n\n${body}` : subject;

          if (!commitsByHash.has(hash)) {
            commitsByHash.set(hash, {
              message: fullMessage,
              date,
              hash,
              branches: new Set([branch])
            });
          } else {
            commitsByHash.get(hash).branches.add(branch);
          }
        }
      }
    }

    return Array.from(commitsByHash.values()).map(commit => ({
      ...commit,
      branches: Array.from(commit.branches).sort()
    }));
  } catch (error) {
    if (error.stderr && error.stderr.includes('fatal: not a git repository')) {
      throw new Error('Not a Git repository. Please run this command from within a Git repository.');
    }
    return [];
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function extractStatusCode(error) {
  return error?.status || error?.code || error?.cause?.status || error?.response?.status;
}

function isRetryableError(error) {
  const status = extractStatusCode(error);
  const message = (error?.message || '').toLowerCase();
  return status === 429 || status === 500 || status === 503 || status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED' || message.includes('temporarily') || message.includes('timeout');
}

function isQuotaOrPermissionError(error) {
  const status = extractStatusCode(error);
  const message = (error?.message || '').toLowerCase();
  return status === 403 || status === 'PERMISSION_DENIED' || status === 'RESOURCE_EXHAUSTED' || message.includes('quota') || message.includes('billing') || message.includes('permission');
}

function isModelNotFound(error) {
  const status = extractStatusCode(error);
  const message = (error?.message || '').toLowerCase();
  return status === 404 || status === 'NOT_FOUND' || message.includes('not found') || message.includes('unsupported');
}

async function callWithRetries(fn) {
  let attempt = 0;
  while (attempt < MAX_AI_RETRIES) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= MAX_AI_RETRIES || !isRetryableError(error)) {
        throw error;
      }
      const waitTime = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`⚠️ AI request failed (attempt ${attempt}/${MAX_AI_RETRIES}). Retrying in ${Math.round(waitTime)}ms...`);
      await sleep(waitTime);
    }
  }
}

function shouldFallbackToNextModel(error) {
  return isQuotaOrPermissionError(error) || isModelNotFound(error) || isRetryableError(error);
}

function formatAggregateError(errors) {
  if (errors.length === 0) return 'Unknown AI error.';
  const lastError = errors[errors.length - 1];
  const details = errors.map(({ model, message }) => `${model}: ${message}`).join(' | ');
  return `AI summarization failed. Details: ${details}. Last error from ${lastError.model}: ${lastError.message}`;
}

async function generateSummary(commits) {
  if (commits.length === 0) {
    return { summary: 'No commits found for the specified period.', modelName: null };
  }

  if (demoMode) {
    const summary = generateDemoSummary(commits);
    return { summary, modelName: 'demo' };
  }

  if (!aiClient) {
    throw new Error('Gemini client is not initialized. Please provide a valid API key.');
  }

  const commitsText = commits.map(c => typeof c === 'string' ? c : c.message).join('\n\n---\n\n');
  const jiraTickets = extractJiraTickets(commits);
  const datePrefix = getDateRelativeText(commits);

  let systemPrompt = `You are an expert project manager. Your task is to convert a list of raw Git commit messages from a developer into a concise, high-level summary. This summary will be read during a daily stand-up meeting to a non-technical audience. Focus on the impact and progress rather than the technical details. Group related changes into a single point. Start the summary with '${datePrefix}...' and use bullet points for the key activities. Keep it brief and business-focused.`;

  if (jiraTickets.length > 0) {
    systemPrompt += ` Also mention any Jira tickets referenced in the commits.`;
  }

  const userPrompt = `Please summarize these Git commit messages:\n\n${commitsText}`;
  const modelsToTry = await getResolvedModelPreference();
  const modelList = modelsToTry || [];

  if (!modelList || modelList.length === 0) {
    throw new Error('No Gemini models are available. Set --model or GEMINI_MODEL to specify one.');
  }

  const errors = [];

  for (let i = 0; i < modelList.length; i += 1) {
    const modelName = modelList[i];
    try {
      const requestPayload = {
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [{ text: userPrompt }]
          }
        ],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: systemPrompt }]
          }
        }
      };

      const response = await callWithRetries(() => aiClient.models.generateContent(requestPayload));
      let summary = extractResponseText(response);

      if (!summary) {
        throw new Error('Model returned an empty response.');
      }

      if (jiraTickets.length > 0 && !summary.includes(jiraTickets[0])) {
        summary += `\n\nJira Tickets: ${jiraTickets.join(', ')}`;
      }

      return { summary, modelName };
    } catch (error) {
      const fallbackAvailable = i < modelList.length - 1;
      errors.push({ model: modelName, message: error.message || 'Unknown error' });

      if (fallbackAvailable && shouldFallbackToNextModel(error)) {
        console.warn(`⚠️ Model ${modelName} is unavailable (${error.message || 'no message'}). Trying next model...`);
        continue;
      }

      const hint = isQuotaOrPermissionError(error)
        ? 'Check your Gemini API quota or select a different model with --model or GEMINI_MODEL.'
        : 'Make sure the Gemini model name is correct and your API key has access to it.';

      throw new Error(`Failed to generate summary with model ${modelName}: ${error.message || 'Unknown error'}. ${hint}`);
    }
  }

  throw new Error(formatAggregateError(errors));
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

function extractResponseText(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  const parts = [];
  response.candidates?.forEach(candidate => {
    candidate?.content?.parts?.forEach(part => {
      if (part?.text) {
        parts.push(part.text);
      }
    });
  });

  return parts.join('\n').trim();
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
    const currentBranch = await getCurrentBranch(repoPath);
    const extraBranches = await getRecentLocalBranches(repoPath, currentBranch, recentBranchesCount);
    const branchesToScan = Array.from(new Set([currentBranch, ...extraBranches]));

    if (branchesToScan.length > 1) {
      console.log(`🌿 Branches scanned: ${branchesToScan.join(', ')}`);
    } else {
      console.log(`🌿 Branch scanned: ${currentBranch}`);
    }

    const commits = await fetchCommits(repoPath, user.email, dateRange, branchesToScan);

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
        const branchLabel = (commit.branches && commit.branches.length > 0)
          ? ` [${commit.branches.join(', ')}]`
          : '';
        const lines = message.split('\n');
        console.log(`${index + 1}. ${lines[0]} ${date ? `(${date})` : ''}${branchLabel}`); // Show subject line with date and branches
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
      const { summary, modelName } = await generateSummary(commits);

      console.log('\n' + '='.repeat(50));
      console.log('📊 STAND-UP SUMMARY');
      console.log('='.repeat(50));
      if (modelName) {
        console.log(`🧠 Model: ${modelName}`);
        console.log('-'.repeat(50));
      }
      console.log(summary);
      if (jiraTickets.length > 0) {
        console.log(`\n🎫 Related Jira Tickets: ${jiraTickets.join(', ')}`);
      }
      console.log('='.repeat(50));
    }

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();
