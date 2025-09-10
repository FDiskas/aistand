# **Execution Plan: Git Commit Summarizer CLI Tool**

## **1\. Project Objective**

To create a Command Line Interface (CLI) tool that automates the preparation for daily stand-up meetings. The tool will fetch a developer's Git commit messages from the previous workday, use a generative AI model to summarize them, and convert them into a concise, business-friendly format.

This will save developers time and help communicate technical progress more effectively to a non-technical audience.

## **2\. Core Features & Scope**

### **In-Scope:**

- **CLI Application:** The tool will be run from the terminal.
- **Local Git Repository:** It will operate on the Git repository located in the directory where the command is run.
- **Automatic Date Calculation:** The tool will automatically determine the date range for the "previous workday." It will intelligently handle weekends (e.g., running on Monday morning will fetch commits from Friday).
- **User Identification:** It will automatically identify the current Git user to fetch the correct commits.
- **AI-Powered Summarization:** It will use the Gemini API to transform technical commit messages into a high-level, easy-to-understand summary.
- **Formatted Output:** The summary will be printed directly to the console in a clean, readable format.

### **Out-of-Scope (for Version 1.0):**

- Jira ticket context via api
- Direct integration with remote Git hosting platforms (e.g., GitHub, GitLab APIs).
- Support for non-Git version control systems.
- Complex user authentication or team management features.

## **3\. Target Audience**

- Software developers who use Git and participate in daily stand-up or status update meetings.

## **4\. Technical Stack**

- **Language:** **nodejs** is recommended due to its strong support for CLI development, file system operations, and API integrations.
- **Key Libraries:**
  - bun: to support typescript

## **5\. High-Level Implementation Plan**

### **Phase 1: Git Interaction & Data Fetching**

1. **Project Setup:** Create the basic project structure, virtual environment, and install initial dependencies.
2. **Identify Git User:** Implement logic to get the user.name and user.email from the local Git configuration.
3. **Calculate Date Range:** Create a function that determines the start and end times for the previous workday. This must account for weekends.
4. **Fetch Commits:** Use the subprocess module to run a git log command with the following filters:
   - \--author: To filter by the identified user.
   - \--since and \--until: To filter by the calculated date range.
   - \--format=%s: To extract only the subject line of each commit message.
5. **Error Handling:** Ensure the tool provides clear error messages if it's not run inside a Git repository or if no commits are found.

### **Phase 2: AI Summarization with Gemini API**

1. **API Client:** Create a dedicated module to handle all interactions with the Gemini API. This will encapsulate the API key and request logic.
2. **Prompt Engineering:** Develop a clear and effective system prompt. This is the most critical part of the AI integration. The prompt will instruct the model on its role, the desired output format, and the tone of voice.
   - **Example System Prompt:**"You are an expert project manager. Your task is to convert a list of raw Git commit messages from a developer into a concise, high-level summary. This summary will be read during a daily stand-up meeting to a non-technical audience. Focus on the _impact_ and _progress_ rather than the technical details. Group related changes into a single point. Start the summary with 'Yesterday, I...' and use bullet points for the key activities."
3. **API Call:**
   - Concatenate the fetched commit messages into a single string.
   - Send this string as the user query to the gemini-2.5-flash-preview-05-20 model along with the system prompt.
   - Implement retry logic with exponential backoff for API calls to handle potential rate limiting.
4. **Process Response:** Parse the JSON response from the API to extract the generated text summary.

### **Phase 3: CLI & User Interface**

1. **Command Structure:** Use argparse to define the main command (e.g., standup-summary).
2. **Optional Arguments:** Add optional flags for advanced use cases:
   - \--date YYYY-MM-DD: To specify a particular day instead of the previous workday.
   - \--path /path/to/repo: To run the tool on a repository other than the current directory.
   - \--verbose: To show the raw commit messages before the summary.
3. **Output Formatting:** Display a loading indicator while the API call is in progress. Print the final, formatted summary to the console.

## **6\. Example Usage Flow**

1. A developer opens their terminal and navigates to their project folder.  
   cd /path/to/my-project

2. They run the command.  
   standup-summary

3. The tool performs the following actions in the background:
   - Checks that it's in a Git repository.
   - Gets the current user's Git identity.
   - Calculates the date range for the previous workday.
   - Fetches the relevant commit messages. For example:
     - feat: implement user login endpoint with JWT auth
     - fix: resolve bug \#123 where password reset fails
     - refactor: optimize database query for user profile page
     - chore: update dependencies
   - Sends these messages to the Gemini API.
4. The final output is printed to the console:  
   Fetching commits...  
   Generating your stand-up summary...

   \------------------------------------

   Yesterday, I...  
   \- Implemented the new user authentication flow, allowing users to log in securely.  
   \- Fixed a critical bug related to the password reset functionality.  
   \- Improved the performance of the user profile page by optimizing a database query.

## **7\. Future Enhancements**

- **Configuration File:** Allow users to define a custom API prompt and other settings in a config file (\~/.standup-summary/config.yaml).
- **Interactive Mode:** After generating a summary, allow the user to approve, edit, or regenerate it.
- **Slack/Teams Integration:** Add an option to post the summary directly to a specified Slack channel or Teams chat.
