/**
 * ZAO - Tool Orchestrator (local Qwen2.5 Coder as Project Manager)
 *
 * This is the layer that makes tools invisible, per the intended
 * architecture:
 *
 *   User -> Chat Screen -> Qwen2.5 Coder (local, Router) -> Tools/Plugins
 *
 * The person never sees a "GitHub button" or a "Terminal button" - they
 * type a plain-language request, the local coder model decides which
 * tool functions to call and in what order, and the chat only ever shows
 * a running checklist of what happened:
 *
 *   Working...
 *   ✓ Created project structure
 *   ✓ Generated 14 files
 *   ✓ Pushed to GitHub
 *
 * This intentionally mirrors server/browserAgent.js's shape (a running conversation,
 * plan/act/observe, a step callback for live progress) but drives real
 * OpenAI-style tool_calls against actual JS functions instead of driving
 * a WebView - GitHub today, Filesystem/Terminal/PDF/Office tools plug into
 * the same TOOL_REGISTRY pattern later without changing this file's core
 * loop.
 *
 * MIGRATION NOTE: this used to call runQwenCoderWithCascade, a 4-step
 * OpenRouter/Hugging Face fallback, and later a local llama.rn context.
 * Both are gone - the coder model is now served by a Termux-hosted
 * backend (src/services/backend/backendClient.js) with no rate limit and
 * nothing to fall back to, so this calls it directly.
 *
 * WHY THIS MODULE BUILDS RAW OpenAI-FORMAT MESSAGES: a tool-calling
 * conversation needs to represent an assistant's tool_calls and a tool
 * result message (role: 'tool', tool_call_id: ...) - shapes that don't fit
 * ZAO's plain {role, content} internal message format. backendClient.js's
 * toBackendMessage() detects these already-OpenAI-shaped messages and
 * passes them through unchanged, so this file builds them directly rather
 * than routing through any shared text-message conversion helper.
 */

import * as llamaEngine from './backend/backendClient';
import { MODEL_KEYS } from '../config/localModels';
import * as githubTool from './github/githubTool';
import * as filesystemTool from './filesystem/filesystemTool';
import * as pdfTool from './pdf/pdfTool';
import * as docxTool from './office/docxTool';
import * as xlsxTool from './office/xlsxTool';
import * as pptxTool from './office/pptxTool';
import * as pcTerminalTool from './terminal/pcTerminalTool';
import * as termuxTerminalTool from './terminal/termuxTerminalTool';
import { checkTerminalStatus } from './terminal/terminalRouter';
import * as webSearchTool from './search/webSearchTool';
import * as timeTool from './time/timeTool';
import * as reminderService from './reminders/reminderService';
import { withProceduralHintReported, recordProcedure } from './memory/proceduralMemory';
import * as dataAnalysisTool from './data/dataAnalysisTool';
import { logUsageEvent, getPreferences } from '../db/database';
import { getToolPermissionDecision } from './execution/permissionModes';
import { runPreToolUseHooks, runPostToolUseHooks } from './execution/hooksEngine';
import { newTraceId, startSpan, endSpan } from './execution/telemetry';
import { spawnSubagents } from './execution/subagentManager';
import * as worktreesTool from './execution/worktrees';
import { assessActionConfidence } from './reasoning/actionConfidence';

const MAX_TOOL_STEPS = 20;

// Terminal tool names - the one TOOL_REGISTRY subset whose confirmation
// override is a `confirmed` flag on the tool's own runner (commandSafety.js)
// rather than a plain re-invocation. Module-scope (not just local to
// runToolTask) so approveAndRunPendingTool below can tell the two re-run
// paths apart without redeclaring this list.
const TERMINAL_TOOL_NAMES_MODULE = new Set(['terminal_pc_run_command', 'terminal_termux_run_command']);

/**
 * OpenAI-style function-calling schema for every GitHub tool function.
 * The local Qwen2.5 Coder model sees these descriptions and decides on its own which to
 * call and in what order - e.g. "create an Expo app and push it to
 * GitHub" naturally chains create_repo -> commit_files.
 */
const GITHUB_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'github_create_repo',
      description: 'Creates a new GitHub repository under the connected account.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Repository name' },
          description: { type: 'string', description: 'Short repository description' },
          isPrivate: { type: 'boolean', description: 'Whether the repo should be private. Defaults to true.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_clone_repo',
      description: "Fetches a repository's file tree and metadata (the read/inspect equivalent of git clone, over the GitHub API).",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_read_file',
      description: 'Reads one file\'s text content from a repository.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          path: { type: 'string', description: 'File path within the repo' },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA. Defaults to the repo\'s default branch.' },
        },
        required: ['owner', 'repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_commit_files',
      description: 'Commits one or more files to a repository in a single atomic commit, and pushes it to the given branch. Use this whenever more than one file needs to land together.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          files: {
            type: 'array',
            description: 'Files to commit',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path within the repo, e.g. src/App.js' },
                content: { type: 'string', description: 'Full text content of the file' },
              },
              required: ['path', 'content'],
            },
          },
          message: { type: 'string', description: 'Commit message' },
          branch: { type: 'string', description: 'Branch to commit to. Defaults to main.' },
        },
        required: ['owner', 'repo', 'files', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_branch',
      description: 'Creates a new branch from the tip of an existing branch (defaults to the repo\'s default branch).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          newBranchName: { type: 'string' },
          fromBranch: { type: 'string' },
        },
        required: ['owner', 'repo', 'newBranchName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_pull_request',
      description: 'Opens a pull request from one branch into another.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          title: { type: 'string' },
          head: { type: 'string', description: 'The branch containing the changes' },
          base: { type: 'string', description: 'The branch to merge into. Defaults to main.' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'title', 'head'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_release',
      description: 'Creates a GitHub release with a version tag. Asset uploads (e.g. an APK) are not available through this chat-facing function - only the release itself.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          tagName: { type: 'string' },
          name: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['owner', 'repo', 'tagName'],
      },
    },
  },
];

const FILESYSTEM_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'fs_create_file',
      description: 'Creates a new text file with given content on the device, at a path relative to the folder the person granted access to. Creates any missing parent folders automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. myproject/src/App.js' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_create_folder',
      description: 'Creates a folder (and any missing parent folders) on the device.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete',
      description: 'Deletes a file or folder on the device.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_rename',
      description: 'Renames a file or folder in place.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Current path' },
          newName: { type: 'string', description: 'New name only, not a full path' },
        },
        required: ['path', 'newName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_move',
      description: 'Moves a file into a different folder on the device. Set copy: true to duplicate instead of moving.',
      parameters: {
        type: 'object',
        properties: {
          sourcePath: { type: 'string' },
          destinationFolder: { type: 'string' },
          copy: { type: 'boolean', description: 'Copy instead of move. Defaults to false.' },
        },
        required: ['sourcePath', 'destinationFolder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_zip',
      description: 'Recursively zips a folder on the device into a single .zip file.',
      parameters: {
        type: 'object',
        properties: {
          folderPath: { type: 'string', description: 'Folder to zip' },
          zipOutputPath: { type: 'string', description: 'Where to write the resulting .zip, e.g. myproject.zip' },
        },
        required: ['folderPath', 'zipOutputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_extract_zip',
      description: 'Extracts a .zip file on the device into a destination folder, recreating its internal structure.',
      parameters: {
        type: 'object',
        properties: {
          zipPath: { type: 'string' },
          destinationFolder: { type: 'string' },
        },
        required: ['zipPath', 'destinationFolder'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_list_folder',
      description: 'Lists the files and folders inside a given folder on the device. Use this to check what already exists before creating/moving/deleting things.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Leave empty for the root of the granted folder' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read_file',
      description: "Reads a text file's content on the device, with line numbers - like Claude Code's Read tool. Use this before fs_edit_file so oldString is copied from the file's real current content, not guessed. Optionally restrict to a line range for a large file.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer', description: '1-indexed, inclusive. Omit to start from the top.' },
          endLine: { type: 'integer', description: '1-indexed, inclusive. Omit to read to the end.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_grep',
      description: "Searches file CONTENTS for a regex pattern across every text file under a folder on the device (recursive) - like Claude Code's Grep. Returns matching file paths, line numbers, and the matching line text.",
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern, no delimiters, e.g. "TODO|FIXME"' },
          path: { type: 'string', description: 'Folder to search under. Leave empty to search the whole granted folder.' },
          caseSensitive: { type: 'boolean', description: 'Defaults to false' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_glob',
      description: "Finds files by NAME pattern (not content) under a folder on the device - like Claude Code's Glob. Supports *, **, and ? wildcards, e.g. \"**/*.test.js\" or \"src/*.json\".",
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.js"' },
          path: { type: 'string', description: 'Folder to search under. Leave empty to search the whole granted folder.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_edit_file',
      description: "Makes a precise, targeted change to one existing text file on the device by replacing an exact snippet with new text - like Claude Code's Edit tool. Safer than rewriting a whole file with fs_create_file: oldString must match the file's current content exactly and uniquely (include enough surrounding context, e.g. a full line or two, to pin it down), or this returns an error instead of guessing. Always fs_read_file the file first so oldString is copied from real current content.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldString: { type: 'string', description: 'Exact existing text to find - must be unique in the file unless replaceAll is set' },
          newString: { type: 'string', description: 'Text to replace it with' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one. Defaults to false.' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_check_syntax',
      description: "Runs a real JS/JSX/TS/TSX/JSON parser against a file already on disk and reports syntax errors with line/column - like Claude Code's own syntax verification. fs_create_file and fs_edit_file already run this automatically before every write and refuse to save broken code, so you don't need to call this right after your own successful edit - use it to double-check a file you didn't just write.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_check_project_syntax',
      description: "Recursively syntax/JSX-checks every JS/JSX/TS/TSX/JSON file under a folder (skipping node_modules/.git/android/ios/build/dist/.expo) and lists every file that fails, with line/column. Call this before telling the person a project is ready, or before starting/building it. This same check also runs automatically as a gate right in front of terminal_pc_run_command/terminal_termux_run_command whenever the command actually starts or builds a project (npm start, expo start, npm run build, etc.) - that automatic gate blocks the run and hands back the exact errors instead of letting a broken project launch, so you'll typically only need to call this tool directly when you want to check proactively, e.g. before saying a task is done.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Folder to check, relative to the granted root. Leave empty to check everything.' } },
        required: [],
      },
    },
  },
];

const PDF_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'pdf_create',
      description: 'Creates a new PDF from structured content (headings and paragraphs, laid out top-to-bottom with automatic page breaks and text wrapping). Write the actual content yourself - this just turns it into a real PDF file.',
      parameters: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            description: 'Ordered content blocks that make up the document',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Optional bold heading for this section' },
                text: { type: 'string', description: 'Optional paragraph text for this section' },
              },
            },
          },
          outputPath: { type: 'string', description: 'Where to save the PDF, relative to the granted folder, e.g. reports/pitch.pdf' },
          title: { type: 'string', description: 'PDF document title metadata' },
          pageSize: { type: 'string', enum: ['a4', 'letter'], description: 'Defaults to a4' },
        },
        required: ['sections', 'outputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_merge',
      description: 'Merges multiple existing PDFs into one, in the given order.',
      parameters: {
        type: 'object',
        properties: {
          inputPaths: { type: 'array', items: { type: 'string' }, description: 'Paths to existing PDFs, in the order they should appear' },
          outputPath: { type: 'string' },
        },
        required: ['inputPaths', 'outputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_split',
      description: 'Splits one PDF into multiple files - either one page per file, or custom page ranges if given.',
      parameters: {
        type: 'object',
        properties: {
          inputPath: { type: 'string' },
          outputFolder: { type: 'string', description: 'Folder to write the split files into' },
          ranges: {
            type: 'array',
            description: 'Optional. If omitted, splits into one PDF per page.',
            items: {
              type: 'object',
              properties: {
                start: { type: 'integer', description: '1-indexed start page, inclusive' },
                end: { type: 'integer', description: '1-indexed end page, inclusive' },
                name: { type: 'string', description: 'Output filename for this range, e.g. chapter1.pdf' },
              },
              required: ['start', 'end', 'name'],
            },
          },
        },
        required: ['inputPath', 'outputFolder'],
      },
    },
  },
];

const OFFICE_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'docx_create',
      description: 'Creates a Word document (.docx) from structured content (headings and paragraphs). Write the actual content yourself - this just turns it into a real Word file. Cannot edit an existing .docx, only create new ones.',
      parameters: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                headingLevel: { type: 'integer', enum: [1, 2, 3], description: 'Defaults to 1' },
                text: { type: 'string' },
              },
            },
          },
          outputPath: { type: 'string', description: 'e.g. reports/proposal.docx' },
          title: { type: 'string', description: 'Document title metadata' },
        },
        required: ['sections', 'outputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xlsx_create',
      description: 'Creates a spreadsheet (.xlsx) with one or more sheets of tabular data. Cell values starting with "=" are written as live formulas (e.g. "=SUM(B2:B9)"), not plain text - use formulas instead of computing and hardcoding a result yourself whenever the sheet should stay correct if its inputs change.',
      parameters: {
        type: 'object',
        properties: {
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Sheet tab name' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: {
                  type: 'array',
                  items: { type: 'array', items: { type: ['string', 'number'] } },
                  description: 'Each inner array is one row, in the same order as headers',
                },
              },
              required: ['name', 'headers', 'rows'],
            },
          },
          outputPath: { type: 'string', description: 'e.g. budget.xlsx' },
        },
        required: ['sheets', 'outputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'csv_create',
      description: 'Creates a plain CSV file from one table of data - simpler and more broadly compatible than xlsx for a flat data export.',
      parameters: {
        type: 'object',
        properties: {
          headers: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
          outputPath: { type: 'string', description: 'e.g. contacts.csv' },
        },
        required: ['headers', 'rows', 'outputPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pptx_create',
      description: 'Creates a PowerPoint presentation (.pptx) from an ordered list of slides - a title slide and/or content slides with bullets or plain text. Write the actual slide content yourself. No charts or images.',
      parameters: {
        type: 'object',
        properties: {
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['title', 'content'] },
                title: { type: 'string' },
                subtitle: { type: 'string', description: 'Only used on a title slide' },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Only used on a content slide' },
                text: { type: 'string', description: 'Only used on a content slide, if not using bullets' },
                notes: { type: 'string', description: 'Speaker notes for this slide' },
              },
              required: ['type'],
            },
          },
          outputPath: { type: 'string', description: 'e.g. pitch.pptx' },
          layout: { type: 'string', enum: ['standard', 'widescreen', 'wide'], description: 'Defaults to widescreen' },
        },
        required: ['slides', 'outputPath'],
      },
    },
  },
];

// Two terminal tools, giving the model real routing choice rather than a
// single fixed backend:
//   - terminal_pc_run_command: full system access on the person's PC
//     (Git Bash/cmd/PowerShell toolchain, APK builds, Docker, AI
//     inference, video processing, Android emulator, Visual Studio) via
//     the PC backend's /terminal/run route (see server/terminal.js and
//     src/services/terminal/pcTerminalTool.js). Requires the PC backend to
//     be reachable (LAN or Remote/Cloudflare tunnel).
//   - terminal_termux_run_command: lightweight, always-on-device via
//     Termux's RUN_COMMAND (see src/services/terminal/termuxTerminalTool.js).
//     Requires the one-time Termux setup (allow-external-apps + accepting
//     Android's RUN_COMMAND permission prompt once).
//   - terminal_check_status: cheap status check the model should call
//     before deciding which of the two to use, since PC reachability and
//     PC internet access can both change between messages (see
//     terminalRouter.js).
const TERMINAL_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'terminal_check_status',
      description: "Checks whether the PC backend is currently reachable and whether the PC itself has internet access right now, plus a plain-language routing recommendation. Call this BEFORE running a shell command whenever you're not already certain which terminal (PC or Termux) is the right choice for the task - status can change between messages.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_pc_run_command',
      description: 'Runs a real shell command via cmd.exe on the person\'s PC - full system access including Git Bash/PowerShell-equivalent tooling, multiple Python versions (python39, python311, etc.), APK builds, Docker, Android emulator, Visual Studio builds, video processing, and AI inference. Best for heavy/resource-intensive tasks. Requires the PC backend to be reachable - if it isn\'t, this returns a clear connection error instead of pretending the command ran. Use terminal_check_status first if unsure.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_termux_run_command',
      description: 'Runs a real shell command directly on the phone via Termux - lightweight and always available on-device (doesn\'t depend on the PC backend). Best for small, fast operations: git pull, npm install, simple Python scripts, curl, ssh, small file downloads. Also the right choice when the PC backend is unreachable or the PC has no internet access. Requires Termux to be installed with the one-time RUN_COMMAND permission granted - if not yet granted, this returns an error with the exact setup command instead of pretending the command ran. Not suited for heavy tasks (APK builds, Docker, emulators, video processing) - the phone doesn\'t have the resources.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

// web_search - lets the local coder model pull in real, current
// information from the open web (see server/webSearch.js / src/services
// /search/webSearchTool.js) instead of answering only from what it was
// trained on. Available any time a request needs it, independent of the
// "Web search" toggle in AttachmentSheet.js - that toggle is a person-
// facing hint the model is more likely to need it this turn, not a hard
// gate, same as the terminal/filesystem tools are always available
// without their own toggle.
const WEB_SEARCH_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Searches the live web and returns matching pages (title, URL, short snippet). Use this for anything time-sensitive, current, or outside what you already know for certain - current events, prices, versions, docs for a library, "what is X" for something unfamiliar, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Short, specific search query' },
          maxResults: { type: 'integer', description: 'Defaults to 5, max 10' },
        },
        required: ['query'],
      },
    },
  },
];

// data_analyze_file - the pandas-backed "data connectivity" tool
// (server/data.js, server/scripts/data_analyze.py). Deliberately a
// small fixed set of structured operations, not a raw query/expression
// string - see that Python script's own header for why (it's not meant
// to be a second, ungated way to run arbitrary code; terminal_pc_run_command
// already covers "I need real Python").
const DATA_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'data_analyze_file',
      description: 'Runs real data analysis (pandas, on the PC backend) against an existing .csv/.tsv/.xlsx/.xls file already in the granted folder - use this instead of fs_read_file for tabular data larger than a quick glance, or whenever you need actual statistics/filtering/grouping rather than just eyeballing raw rows. NOT for creating spreadsheets (use xlsx_create for that) and NOT arbitrary code execution.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the .csv/.tsv/.xlsx/.xls file, relative to the granted folder' },
          operation: { type: 'string', enum: ['describe', 'head', 'filter', 'groupby'], description: "'describe' = summary statistics for every column (good first call on an unfamiliar file). 'head' = first N rows. 'filter' = rows matching one column condition. 'groupby' = aggregate (e.g. sum/mean) grouped by one or more columns." },
          sheet: { type: 'string', description: 'Sheet name for .xlsx/.xls files - defaults to the first sheet if omitted' },
          n: { type: 'integer', description: "Row cap for 'head'/'filter'/'groupby' results - defaults to 50, capped at 200" },
          filter: {
            type: 'object',
            description: "Required when operation is 'filter'",
            properties: {
              column: { type: 'string' },
              op: { type: 'string', enum: ['==', '!=', '>', '<', '>=', '<=', 'contains'] },
              value: { description: 'Value to compare against - string or number' },
            },
          },
          groupby: {
            type: 'object',
            description: "Required when operation is 'groupby'",
            properties: {
              by: { type: 'array', items: { type: 'string' }, description: 'Column(s) to group by' },
              agg: { type: 'object', description: "Map of column name -> aggregation, e.g. { \"sales\": \"sum\", \"price\": \"mean\" }" },
            },
          },
        },
        required: ['path', 'operation'],
      },
    },
  },
];
// and (see runToolTask below) flags the reply to render a live
// ClockWidget (digital HH:MM:SS + analog face, src/components/
// ClockWidget.js) instead of just a text sentence. No backend call - see
// src/services/time/timeTool.js's header for why this needs no network
// round-trip at all.
const TIME_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'time_get_current',
      description: "Gets the current date and time for a city, country, or IANA timezone (e.g. \"Tokyo\", \"Asia/Tokyo\", \"UTC\") - or the device's own local time if no place is given. Use this for any \"what time is it\" / \"what's the time in...\" request. The reply automatically shows a live clock, so just confirm the place in words - don't restate the exact time yourself, since the tool result already includes it and the clock updates live.",
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'A city, country, or IANA timezone name. Omit for the device\'s own local time.' },
        },
      },
    },
  },
];

// Reminders / prospective memory (see src/services/reminders/reminderService.js).
// Unlike the other tools here, these read from and write to a ZAO-owned
// SQLite table, not just an external system - reminder_list is what lets
// the model actually answer "what have you got reminders set for?"
// truthfully instead of guessing, since prior to this the OS notification
// shade was the only place that information existed at all.
const REMINDER_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'reminder_create',
      description: "Schedules a reminder/follow-up for a future time - \"remind me to X at/in Y.\" Resolve relative phrasing (\"in 20 minutes,\" \"tomorrow at 9am\") to an absolute ISO 8601 datetime yourself using time_get_current first if you need the current time/timezone to do that math. Set repeat only if the person actually asked for a recurring reminder.",
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to remind the person about, in their own words (e.g. "check the broiler feeders").' },
          triggerAtIso: { type: 'string', description: 'Absolute ISO 8601 datetime the reminder should fire at, e.g. "2026-07-20T09:00:00-04:00".' },
          repeat: { type: 'string', enum: ['none', 'daily', 'weekly'], description: "Defaults to 'none' (one-shot) if omitted." },
        },
        required: ['message', 'triggerAtIso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reminder_list',
      description: "Lists reminders ZAO currently has scheduled, so you can answer \"what reminders do I have\" or check before creating a possible duplicate. Set includeCompleted to also see fired/cancelled/failed ones (e.g. if the person asks whether something already went off, or whether a reminder actually failed to schedule).",
      parameters: {
        type: 'object',
        properties: {
          includeCompleted: { type: 'boolean', description: 'Defaults to false (pending reminders only).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reminder_cancel',
      description: 'Cancels a still-pending reminder by id (get the id from reminder_list first if you only have a description of which one).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The reminder id, from reminder_list.' },
        },
        required: ['id'],
      },
    },
  },
];

// todo_write - a live task checklist for the CURRENT request, like Claude
// Code's TodoWrite tool. Call it once near the start of any multi-step
// task to lay out the plan, then again as items complete, so the person
// sees real progress ("✓ Created App.js", "→ Installing dependencies",
// "○ Push to GitHub") instead of silence until the whole thing finishes.
// This is intentionally NOT the same thing as the hierarchical
// Strategic/Project/Task plan tree in src/services/planning/ (that's a
// separate, persisted, PlanScreen-visible structure for genuinely large
// multi-part builds) - this is a lightweight, disposable checklist
// scoped to one runToolTask() call, surfaced through the same onStep
// callback every other tool already reports through.
const TODO_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: "Creates or updates a live checklist of steps for the CURRENT task, shown to the person as progress happens. Call this first for any task with 3+ distinct steps, marking the one you're about to do as 'in_progress' and the rest 'pending', then call it again each time a step's status changes. Keeps exactly one item 'in_progress' at a time.",
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Short description of the step' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

// agent_spawn_subagents - ZAO's Subagents/Agent Teams equivalent (see
// src/services/execution/subagentManager.js). Only offered to the TOP
// level model, never to a subagent itself (runToolTask filters this
// schema out of allSchemas when context.isSubagent is true, right before
// the loop below) - one level of isolation, no sub-subagents.
const SUBAGENT_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'agent_spawn_subagents',
      description: "Spawns one or more subagents to work on independent parts of the task IN PARALLEL, each with its OWN isolated context (a fresh, empty conversation - it sees only the prompt you give it, nothing from this conversation and nothing from any sibling subagent). You only see each subagent's final answer, not its intermediate tool calls - use this to keep this conversation's context clean when a task has genuinely independent sub-parts (e.g. 'write the backend route' + 'write the frontend screen' + 'write the tests' can run at once, each with full room to read/search/iterate without eating into your own context). Do NOT use this for a single simple task, or for steps that depend on each other's output - those should just be done directly in order.",
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '1-5 independent subtasks to run in parallel',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: "Short label for this subagent's work, shown in the live checklist (e.g. 'Backend route')" },
                prompt: { type: 'string', description: "The COMPLETE, self-contained instruction for this subagent - it has no other context, so include everything it needs to know (file paths, what already exists, what 'done' looks like)." },
              },
              required: ['description', 'prompt'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
];

// agent_create_worktree / agent_list_worktrees - ZAO's Worktrees
// equivalent (see src/services/execution/worktrees.js). Only offered at
// the top level, same as subagents - a worktree is a fork of THIS
// conversation, which isn't a meaningful concept for a subagent that has
// no conversation of its own to fork from. sourceConversationId always
// comes from the caller's own context (never a model-supplied arg) so a
// worktree can only ever be forked from the conversation actually
// running this loop - see the special-cased dispatch below.
const WORKTREE_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'agent_create_worktree',
      description: "Splits off an isolated parallel session on a new branch, so you (or the person) can work on two branches of the same project at once without one session's uncommitted state stepping on the other's - Claude Code's 'worktree' concept. Picks one of two backends depending on what's reachable: 'pc_git_worktree' runs a real `git worktree add` on the PC terminal (requires repoPath - the existing local repo - and worktreePath - where to check the new one out to; use terminal_check_status first if unsure the PC is reachable), or 'github' creates a GitHub branch via the repo API (requires owner and repo) when there's no reachable local checkout. Either way, this creates a NEW isolated chat conversation for the branch and returns its id - tell the person a new conversation was created for it.",
      parameters: {
        type: 'object',
        properties: {
          backend: { type: 'string', enum: ['pc_git_worktree', 'github'], description: "'pc_git_worktree' for a real local git worktree on the PC; 'github' for a branch-only session when there's no reachable local checkout." },
          branch: { type: 'string', description: 'New branch name for this parallel session' },
          baseBranch: { type: 'string', description: "Branch to fork from (defaults to the repo's default branch / HEAD)" },
          owner: { type: 'string', description: 'GitHub repo owner - required for both backends if a repo is involved' },
          repo: { type: 'string', description: 'GitHub repo name' },
          repoPath: { type: 'string', description: "For pc_git_worktree: the existing local repo's path on the PC" },
          worktreePath: { type: 'string', description: 'For pc_git_worktree: where to check the new worktree out to' },
        },
        required: ['backend', 'branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_list_worktrees',
      description: "Lists this person's currently active worktree sessions (parallel branches with their own conversation) across both backends. Use this before creating a new one if you're not sure what's already in flight, or when the person asks what parallel work they have going.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

// Maps schema function names to the real githubTool.js implementation and
// a short human-readable label for the chat checklist (e.g. "Created
// repository", not the raw function name). Adding a new tool later
// (filesystem, terminal, pdf, office) means adding its schemas + this kind
// of registry entry, not changing the loop below.
export const TOOL_REGISTRY = {
  github_create_repo: {
    run: (args) => githubTool.createRepo(args.name, { description: args.description, isPrivate: args.isPrivate }),
    label: (args) => `Created repository ${args.name}`,
  },
  github_clone_repo: {
    run: (args) => githubTool.cloneRepo(args.owner, args.repo),
    label: (args) => `Read ${args.owner}/${args.repo}`,
  },
  github_read_file: {
    run: (args) => githubTool.readFile(args.owner, args.repo, args.path, args.ref),
    label: (args) => `Read ${args.path}`,
  },
  github_commit_files: {
    run: (args) => githubTool.commitFiles(args.owner, args.repo, args.files, args.message, args.branch),
    label: (args) => `Generated ${args.files.length} file${args.files.length === 1 ? '' : 's'}, pushed to GitHub`,
  },
  github_create_branch: {
    run: (args) => githubTool.createBranch(args.owner, args.repo, args.newBranchName, args.fromBranch),
    label: (args) => `Created branch ${args.newBranchName}`,
  },
  github_create_pull_request: {
    run: (args) => githubTool.createPullRequest(args.owner, args.repo, args),
    label: (args) => `Opened pull request: ${args.title}`,
  },
  github_create_release: {
    run: (args) => githubTool.createRelease(args.owner, args.repo, args),
    label: (args) => `Created release ${args.tagName}`,
  },
  fs_create_file: {
    run: (args) => filesystemTool.createFile(args.path, args.content),
    label: (args) => `Created ${args.path}`,
  },
  fs_create_folder: {
    run: (args) => filesystemTool.createFolder(args.path),
    label: (args) => `Created folder ${args.path}`,
  },
  fs_delete: {
    run: (args) => filesystemTool.deleteEntry(args.path),
    label: (args) => `Deleted ${args.path}`,
  },
  fs_rename: {
    run: (args) => filesystemTool.renameEntry(args.path, args.newName),
    label: (args) => `Renamed ${args.path} to ${args.newName}`,
  },
  fs_move: {
    run: (args) => filesystemTool.moveEntry(args.sourcePath, args.destinationFolder, { keepOriginal: !!args.copy }),
    label: (args) => `${args.copy ? 'Copied' : 'Moved'} ${args.sourcePath} to ${args.destinationFolder}`,
  },
  fs_zip: {
    run: (args) => filesystemTool.zipFolder(args.folderPath, args.zipOutputPath),
    label: (args) => `Zipped ${args.folderPath} to ${args.zipOutputPath}`,
  },
  fs_extract_zip: {
    run: (args) => filesystemTool.extractZip(args.zipPath, args.destinationFolder),
    label: (args) => `Extracted ${args.zipPath} to ${args.destinationFolder}`,
  },
  fs_list_folder: {
    run: (args) => filesystemTool.listFolder(args.path || ''),
    label: (args) => `Checked contents of ${args.path || '(root)'}`,
  },
  fs_read_file: {
    run: (args) => filesystemTool.readFile(args.path, { startLine: args.startLine, endLine: args.endLine }),
    label: (args) => `Read ${args.path}`,
  },
  fs_grep: {
    run: (args) => filesystemTool.grep(args.pattern, { path: args.path || '', caseSensitive: !!args.caseSensitive }),
    label: (args) => `Searched for "${args.pattern}"${args.path ? ` in ${args.path}` : ''}`,
  },
  fs_glob: {
    run: (args) => filesystemTool.globFiles(args.pattern, { path: args.path || '' }),
    label: (args) => `Found files matching ${args.pattern}`,
  },
  fs_edit_file: {
    run: (args) => filesystemTool.editFile(args.path, args.oldString, args.newString, { replaceAll: !!args.replaceAll }),
    label: (args) => `Edited ${args.path}`,
  },
  fs_check_syntax: {
    run: (args) => filesystemTool.checkFileSyntax(args.path),
    label: (args) => `Syntax-checked ${args.path}`,
  },
  fs_check_project_syntax: {
    run: (args) => filesystemTool.checkProjectSyntax(args.path || ''),
    label: (args) => `Syntax-checked project${args.path ? ` (${args.path})` : ''}`,
  },
  web_search: {
    run: (args) => webSearchTool.search(args.query, args.maxResults || 5),
    label: (args) => `Searched the web: "${args.query}"`,
  },
  data_analyze_file: {
    run: (args) => dataAnalysisTool.analyzeFile(args.path, {
      operation: args.operation, sheet: args.sheet, n: args.n, filter: args.filter, groupby: args.groupby,
    }),
    label: (args) => `Analyzed ${args.path} (${args.operation})`,
  },
  time_get_current: {
    run: (args) => timeTool.getCurrentTime(args.timezone || null),
    label: (args) => `Checked the time${args.timezone ? ` in ${args.timezone}` : ''}`,
  },
  reminder_create: {
    // Special-cased for the same reason as agent_create_worktree above:
    // sourceConversationId must be THIS call's real conversationId
    // (context), never something the model itself supplies - see the
    // dispatch site in the loop below.
    run: null,
    label: (args) => `Set a reminder: ${args.message}`,
  },
  reminder_list: {
    run: (args) => reminderService.listReminders({ includeCompleted: !!args.includeCompleted }),
    label: () => 'Checked scheduled reminders',
  },
  reminder_cancel: {
    run: (args) => reminderService.cancelReminder(args.id),
    label: () => 'Cancelled a reminder',
  },
  todo_write: {
    run: (args) => Promise.resolve({ success: true, data: { todos: args.todos }, error: null }),
    label: (args) => {
      const total = args.todos.length;
      const done = args.todos.filter((t) => t.status === 'completed').length;
      const active = args.todos.find((t) => t.status === 'in_progress');
      const checklist = args.todos
        .map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○'} ${t.content}`)
        .join('\n');
      return `Updated task list (${done}/${total} done)${active ? ` - now: ${active.content}` : ''}\n${checklist}`;
    },
  },
  pdf_create: {
    run: (args) => pdfTool.createPdf(args.sections, args.outputPath, { title: args.title, pageSize: args.pageSize }),
    label: (args) => `Created ${args.outputPath}`,
  },
  pdf_merge: {
    run: (args) => pdfTool.mergePdfs(args.inputPaths, args.outputPath),
    label: (args) => `Merged ${args.inputPaths.length} PDFs into ${args.outputPath}`,
  },
  pdf_split: {
    run: (args) => pdfTool.splitPdf(args.inputPath, args.outputFolder, args.ranges || null),
    label: (args) => `Split ${args.inputPath} into ${args.outputFolder}`,
  },
  docx_create: {
    run: (args) => docxTool.createDocx(args.sections, args.outputPath, { title: args.title }),
    label: (args) => `Created ${args.outputPath}`,
  },
  xlsx_create: {
    run: (args) => xlsxTool.createXlsx(args.sheets, args.outputPath),
    label: (args) => `Created ${args.outputPath}`,
  },
  csv_create: {
    run: (args) => xlsxTool.createCsv(args.headers, args.rows, args.outputPath),
    label: (args) => `Created ${args.outputPath}`,
  },
  pptx_create: {
    run: (args) => pptxTool.createPptx(args.slides, args.outputPath, { layout: args.layout }),
    label: (args) => `Created ${args.outputPath}`,
  },
  terminal_check_status: {
    run: async () => {
      const status = await checkTerminalStatus();
      return { success: true, data: status, error: null };
    },
    label: () => 'Checked terminal status',
  },
  terminal_pc_run_command: {
    run: (args) => pcTerminalTool.runCommand(args.command),
    label: (args) => `Ran on PC: ${args.command}`,
  },
  terminal_termux_run_command: {
    run: (args) => termuxTerminalTool.runCommand(args.command),
    label: (args) => `Ran on Termux: ${args.command}`,
  },
  agent_spawn_subagents: {
    // The (context, onStep) this needs comes from runToolTask's closure -
    // see the special-cased call site in the loop below rather than the
    // generic `toolDef.run(args)` every other tool uses, since this is
    // the one tool whose implementation needs the CALLER's context/onStep,
    // not just its own args.
    run: null,
    label: (args) => `Ran ${args.tasks.length} subagent${args.tasks.length === 1 ? '' : 's'} in parallel: ${args.tasks.map((t) => t.description).join(', ')}`,
  },
  agent_create_worktree: {
    // Special-cased for the same reason as agent_spawn_subagents: needs
    // the CALLER's conversationId (context), not something the model
    // supplies - see the dispatch site in the loop below.
    run: null,
    label: (args) => `Created worktree session on branch ${args.branch}`,
  },
  agent_list_worktrees: {
    run: async () => {
      const sessions = await worktreesTool.listActiveWorktreeSessions();
      return { success: true, data: sessions, error: null };
    },
    label: () => 'Checked active worktree sessions',
  },
};

/**
 * Maps a tool function name to a genuine usage-dashboard category. Kept
 * as an explicit mapping (not a naming convention/prefix guess) so the
 * dashboard's categories stay meaningful even as more tools get added
 * later - e.g. both fs_create_file and pdf_create/docx_create/etc.
 * legitimately count as "file created," which isn't derivable from the
 * function name alone.
 */
/**
 * Tags a tool call with a coarse domain string, the same shape
 * src/services/planning/executionPlanner.js already puts on each
 * hierarchical plan step (plan_steps.domain / 'domain' in a recorded
 * procedure's steps_json). Lets runToolTask's own successful runs feed
 * the SAME procedures table the hierarchical planner writes to/reads
 * from (see proceduralMemory.js), instead of needing a parallel
 * domain taxonomy just for the flat loop.
 */
function domainForTool(toolName) {
  if (toolName.startsWith('github_')) return 'github';
  if (toolName.startsWith('fs_')) return 'filesystem';
  if (toolName.startsWith('terminal_')) return 'terminal';
  if (toolName.startsWith('pdf_')) return 'pdf';
  if (['docx_create', 'xlsx_create', 'csv_create', 'pptx_create'].includes(toolName)) return 'office';
  if (toolName === 'web_search') return 'search';
  if (toolName === 'data_analyze_file') return 'data';
  if (toolName.startsWith('reminder_')) return 'reminders';
  if (toolName.startsWith('agent_')) return 'agent';
  return 'general';
}

function eventTypeForTool(functionName) {
  const map = {
    github_create_repo: 'github_repo_created',
    github_commit_files: 'github_push',
    github_create_branch: 'github_branch_created',
    github_create_pull_request: 'github_pr_opened',
    github_create_release: 'github_release_created',
    github_clone_repo: 'github_read',
    github_read_file: 'github_read',
    fs_create_file: 'file_created',
    fs_create_folder: 'file_created',
    fs_delete: 'file_deleted',
    fs_rename: 'file_modified',
    fs_move: 'file_modified',
    fs_zip: 'file_created',
    fs_extract_zip: 'file_created',
    fs_list_folder: 'file_browsed',
    fs_read_file: 'file_browsed',
    fs_grep: 'file_browsed',
    fs_glob: 'file_browsed',
    fs_edit_file: 'file_modified',
    fs_check_syntax: 'file_browsed',
    fs_check_project_syntax: 'file_browsed',
    web_search: 'web_search',
    time_get_current: 'time_checked',
    reminder_create: 'reminder_created',
    reminder_list: 'reminder_listed',
    reminder_cancel: 'reminder_cancelled',
    data_analyze_file: 'data_analyzed',
    todo_write: 'todo_updated',
    pdf_create: 'file_created',
    pdf_merge: 'file_created',
    pdf_split: 'file_created',
    docx_create: 'file_created',
    xlsx_create: 'file_created',
    csv_create: 'file_created',
    pptx_create: 'file_created',
    terminal_check_status: 'terminal_attempted',
    terminal_pc_run_command: 'terminal_attempted',
    terminal_termux_run_command: 'terminal_attempted',
    agent_spawn_subagents: 'subagent_run',
    agent_create_worktree: 'worktree_created',
    agent_list_worktrees: 'worktree_listed',
  };
  return map[functionName] || 'tool_call';
}

/**
 * A short, non-sensitive summary of a tool call's arguments for the
 * usage log's metadata column - NOT the full arguments (which could
 * include full file contents, entire PDF section text, etc. - far too
 * large and unnecessary for a usage count/trace).
 */
function summarizeArgsForLog(args) {
  const summary = {};
  for (const key of ['path', 'outputPath', 'name', 'owner', 'repo', 'sourcePath', 'destinationFolder', 'folderPath', 'pattern', 'query']) {
    if (args[key] !== undefined) summary[key] = args[key];
  }
  return summary;
}

function toolResultMessage(toolCallId, resultPayload) {
  return { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(resultPayload) };
}

/**
 * Runs one user request through the local Qwen2.5 Coder model with all
 * tools available, looping through any tool_calls it makes until it gives
 * a final plain-language answer (or MAX_TOOL_STEPS is hit). Calls the
 * local llama.rn context directly (src/services/llama/llamaEngine.js) -
 * no cascade, no cloud fallback, since there's only one coder model and no
 * rate limit to fall back from.
 *
 * Combines every registered tool's schemas (GitHub + Filesystem so far,
 * more added the same way later) into one call so a single request like
 * "create these files and push them to GitHub" can naturally chain
 * fs_create_file calls with a github_commit_files call, without the
 * person needing to phrase it as two separate requests.
 *
 * EXECUTION/SAFETY (see src/services/execution/, EXECUTION_SAFETY.md):
 * every tool call in the loop below now goes through three gates in
 * order, all of which existed as separate concerns before but are wired
 * together here for the first time:
 *   1. Permission mode (permissionModes.js) - is this tool even allowed
 *      to run in the current mode, and if allowed, does it need human
 *      confirmation first? 'plan' mode blocks outright; 'default' asks
 *      for confirmation on writes; 'acceptEdits'/'auto'/'bypassPermissions'
 *      auto-run more of them. Since there's no in-chat confirmation UI
 *      yet (same gap SYSTEM_COMPONENTS.md's human-in-the-loop section
 *      flags for the flat tool loop), a confirmation requirement fails
 *      the call closed with a clear reason rather than running
 *      unattended - consistent with commandSafety.js's pre-existing
 *      behavior for risky terminal commands.
 *   2. PreToolUse hooks (hooksEngine.js) - any registered hook matching
 *      this tool name runs BEFORE it, and can block the call.
 *   3. Telemetry span (telemetry.js) - every call gets a start/end span
 *      in agent_actions regardless of outcome, so there's always a
 *      queryable record of what ran, in what order, and why it stopped.
 * PostToolUse hooks run after, with the real result available to them.
 *
 * PROCEDURAL MEMORY (src/services/memory/proceduralMemory.js): every
 * call checks, unprompted, whether a similar past request has already
 * been solved (withProceduralHintReported) and folds a "here's what
 * worked before" hint into the model's own copy of the request if so -
 * surfaced to the person via onStep, not just silently steering the
 * model. On a successful finish, the steps actually taken are recorded
 * back the same way (recordProcedure) so this loop's own successes
 * become future hints too, feeding and reading the same bank the
 * hierarchical planner (backendBrain.js) already used one-directionally.
 *
 * @param {string} userRequest - the person's message, e.g. "create an Expo app and push it to GitHub"
 * @param {object} context - { githubUsername, permissionMode, sessionId, conversationId, traceId, parentSpanId, isSubagent } - permissionMode/sessionId/traceId are all optional and resolved to sensible defaults (see below) so every EXISTING call site (which only ever passed githubUsername) keeps working unchanged.
 * @param {function} onStep - optional callback(label) fired each time a tool call completes, for the chat's live "✓ ..." checklist
 * @returns {Promise<{success: boolean, answer: string|null, error: object|null, stepsCompleted: string[]}>}
 */
export async function runToolTask(userRequest, context = {}, onStep = null) {
  const { githubUsername = null, isSubagent = false, conversationId = null } = context;

  // permissionMode isn't always passed explicitly (most existing call
  // sites predate this feature) - fall back to whatever's persisted in
  // Settings, and fall further back to 'default' (ZAO's original,
  // always-confirm-risky-things behavior) if prefs can't be read at all.
  let permissionMode = context.permissionMode;
  if (!permissionMode) {
    const prefsResult = await getPreferences().catch(() => null);
    permissionMode = prefsResult?.data?.permission_mode || 'default';
  }

  const traceId = context.traceId || newTraceId();
  const sessionId = context.sessionId || traceId;
  const parentSpanId = context.parentSpanId || null;

  const systemPrompt = `You are ZAO's project manager. The person describes what they want in plain language; you decide which tool functions to call, in what order, to accomplish it - they should never need to name a specific function or press a button themselves.

You have these kinds of tools available: GitHub (repos, commits, branches, PRs, releases), Filesystem (creating/moving/renaming/deleting/zipping files directly on the person's device, plus fs_read_file/fs_grep/fs_glob/fs_edit_file for precisely reading and editing existing code or text files), Data analysis (data_analyze_file - real pandas-backed describe/head/filter/groupby on an existing .csv/.tsv/.xlsx/.xls file, for anything beyond a quick glance), PDF (create/merge/split), Office (docx_create for Word documents, xlsx_create/csv_create for spreadsheets, pptx_create for presentations - write the actual document/spreadsheet/slide content yourself, each tool just turns it into a real file), Terminal, and Web Search - use whichever combination the request actually needs.${isSubagent ? '' : `

You can also spawn subagents (agent_spawn_subagents) for genuinely independent sub-parts of a bigger task - each one runs in its own isolated context in parallel and reports back only its final answer. Use this for real parallelism (e.g. three unrelated files at once), not for ordinary sequential steps.

If the person wants to work on two branches of the same project at once without them interfering, use agent_create_worktree (agent_list_worktrees to see what's already active) - it forks off a new, isolated conversation for the branch.`}

When changing an EXISTING file, prefer fs_read_file then fs_edit_file over fs_create_file - fs_edit_file makes one precise, targeted change and fails safely if what you're replacing isn't unique in the file, instead of risking an unrelated rewrite. Use fs_grep to find where something is defined/used across a project, and fs_glob to find files by name pattern (e.g. all .test.js files) before deciding what to touch.

Every fs_create_file and fs_edit_file call against a .js/.jsx/.ts/.tsx/.json file is automatically syntax/JSX-checked with a real parser before anything is written - if the content is broken, the call fails with the exact line/column instead of saving bad code, so fix the reported error and retry rather than treating it as a system problem. Before telling the person a project is ready, or before running/building it, call fs_check_project_syntax - the same check also runs automatically right before terminal_pc_run_command/terminal_termux_run_command whenever the command starts or builds a project (npm start, expo start, npm run build, etc.), and blocks the run with the exact errors if anything fails.

Use web_search for anything time-sensitive, current, or that you're not confident about from what you already know - current events, prices, library versions, docs, unfamiliar topics.

For "what time is it" / "what's the time in [place]" requests, call time_get_current - the reply automatically shows a live updating clock, so just name the place in your answer and don't restate the exact time yourself (it may be a few seconds stale by the time the person reads it; the clock widget is always current).

For any task with 3 or more distinct steps, call todo_write first to lay out the plan (one item 'in_progress', the rest 'pending'), then call it again as each step's status changes - this is how the person sees live progress instead of silence until everything finishes.

Terminal has TWO backends and you choose between them: terminal_pc_run_command (full system access on the person's PC - Git Bash/cmd/PowerShell tooling, multiple Python versions, APK builds, Docker, Android emulator, Visual Studio builds, video processing, AI inference - best for anything heavy) and terminal_termux_run_command (lightweight, runs directly on the phone - git pull, quick npm install, simple scripts, curl, ssh, small downloads - always available even when the PC isn't). Call terminal_check_status first whenever you're not already confident which one fits: it tells you if the PC backend is reachable and whether the PC itself currently has internet access. If the PC is unreachable, or reachable but offline, route accordingly - use Termux for lightweight/internet-dependent work, and if a request genuinely needs something only the PC can do (a heavy build, Docker, the emulator) while the PC is down, tell the person clearly rather than attempting a workaround that won't actually work.

${permissionMode === 'plan' ? "You are currently in PLAN MODE - read-only. You can read, search, and lay out a plan (todo_write), but every tool that would create/edit/delete/run something will be refused. Explain what you WOULD do; don't attempt to actually do it yet.\n\n" : ''}${githubUsername ? `Their GitHub username is "${githubUsername}" - use this as the owner for new repos unless they specify an organization instead.` : 'No GitHub username is on file yet - ask for it if a GitHub action needs an owner and none is given in the request.'}

When generating file content (for fs_create_file or github_commit_files), write complete, working file content - not placeholders or "TODO" stubs. Once everything requested is actually done, give a short, plain-language summary of what was created/changed - don't just say "done", name what happened.`;

  // PROCEDURAL memory (src/services/memory/proceduralMemory.js): before
  // this, withProceduralHint() only ever fired inside the hierarchical
  // planner (backendBrain.js) - this flat loop never checked "have I
  // solved something like this before," even though the SAME procedures
  // table also gets written to by hierarchical runs (and, as of the
  // write side below, by this loop itself). Self-triggered: nothing
  // about this call site changes to opt in - every flat-loop request
  // now gets checked automatically, same as every hierarchical goal
  // already does.
  const hint = await withProceduralHintReported(userRequest).catch(() => ({ text: userRequest, applied: false, matchSummary: null }));
  if (hint.applied) onStep?.(`Recognized a similar past task ("${hint.matchSummary}") - reusing that approach`);

  // SCRATCHPAD memory (src/services/memory/memoryTypes.js /
  // MEMORY_ARCHITECTURE.md): this call's own in-memory ReAct trail,
  // discarded when runToolTask() returns. See
  // src/services/memory/scratchpad.js for the shared shape this
  // pattern is formalized as, for any future loop. This isolation is
  // also exactly what makes subagentManager.js's context-isolation
  // guarantee true - a fresh history per call, nothing shared.
  const history = [
    { role: 'system', content: systemPrompt },
    // hint.text is userRequest UNCHANGED when no similar procedure was
    // found - this line behaves exactly as before in that case.
    { role: 'user', content: hint.text },
  ];

  const stepsCompleted = hint.applied ? [`Recognized a similar past task ("${hint.matchSummary}") - reusing that approach`] : [];
  // Parallel to stepsCompleted but shaped for proceduralMemory.js
  // (domain + description per step) rather than for display - fed into
  // recordProcedure() once this run finishes successfully, so the flat
  // loop's own successes become future hints too, not just the
  // hierarchical planner's. todo_write is intentionally excluded (it's
  // checklist bookkeeping about THIS run, not a reusable action).
  const executedSteps = [];
  // Set whenever a time_get_current call succeeds - carried through to
  // the final return below so runToolTaskHandler (src/utils/
  // orchestrator.js) can attach it to the reply, letting ChatScreen.js
  // render a live ClockWidget on that specific bubble (same pattern as
  // planId -> "View Plan" chip). Only the LAST successful time lookup
  // wins if the model checks more than one place in a single turn -
  // reasonable since the chat bubble can only show one widget.
  let clockData = null;
  // Set the first time ANY tool call is refused specifically because it
  // needs human confirmation (permissionModes.js's requiresConfirmation -
  // a RISKY terminal command per commandSafety.js, OR a WRITE_TOOL /
  // DESTRUCTIVE_TOOL in 'default'/'acceptEdits' mode: a GitHub push, a
  // file delete, a generated document) - carried through to the final
  // return below so runToolTaskHandler/chatStore can attach it to the
  // reply as messages.pending_confirmation, letting ChatScreen.js render
  // a real "Approve?" card instead of the call just failing closed with
  // no way to ever run it. Only the FIRST one this turn is captured - if
  // the model tries several confirmable calls in one turn, the person
  // approves them one at a time (a fresh reply after each approval
  // covers any that follow).
  //
  // FIX (previously terminal-only): this used to only fire for
  // TERMINAL_TOOL_NAMES, because runCommand's `confirmed` option
  // (pcTerminalTool.js / termuxTerminalTool.js) was the only re-invocation
  // path that existed - see HARDENING_NOTES.md. That meant the flat tool
  // loop had human-in-the-loop for shell commands but NOT for GitHub,
  // filesystem, PDF, or Office tools: a risky call there just returned a
  // failure tool result to the model with no card and no way to approve
  // it, unlike the hierarchical plan path (planExecutor.js), which pauses
  // ANY is_risky step the same way regardless of domain. Now every
  // confirmable tool, not just terminal, gets captured here, and
  // approveAndRunPendingTool() below knows how to re-invoke any of them.
  let pendingConfirmation = null;
  const allSchemas = [
    ...GITHUB_TOOL_SCHEMAS, ...FILESYSTEM_TOOL_SCHEMAS, ...PDF_TOOL_SCHEMAS, ...OFFICE_TOOL_SCHEMAS,
    ...TERMINAL_TOOL_SCHEMAS, ...WEB_SEARCH_TOOL_SCHEMAS, ...DATA_TOOL_SCHEMAS, ...TIME_TOOL_SCHEMAS, ...REMINDER_TOOL_SCHEMAS, ...TODO_TOOL_SCHEMAS,
    // Recursion guard (subagentManager.js header): a subagent never sees
    // its own spawn tool.
    ...(isSubagent ? [] : SUBAGENT_TOOL_SCHEMAS),
    // Same reasoning: a worktree forks THIS conversation, which a
    // subagent (no conversation of its own) can't meaningfully do.
    ...(isSubagent ? [] : WORKTREE_TOOL_SCHEMAS),
  ];

  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      tools: allSchemas,
      maxTokens: 2048,
      temperature: 0.3,
    });

    if (!modelResult.success) {
      return { success: false, answer: null, error: modelResult.error, stepsCompleted, clockData, pendingConfirmation };
    }

    const { content, toolCalls } = modelResult.data;

    if (!toolCalls) {
      // No more tool calls - this is the model's final answer.
      // Write side of procedural memory for this loop (see the read
      // side above): a real task actually got done here, so it's worth
      // remembering the same way planExecutor.js remembers a completed
      // hierarchical plan. Recorded against the ORIGINAL userRequest,
      // not hint.text - keeps goal_summary clean for future matching
      // instead of accumulating a previous hint's text onto itself
      // across repeated reuse. Fire-and-forget: never delays the
      // person's answer.
      if (executedSteps.length > 0) {
        recordProcedure(userRequest, executedSteps, null).catch((err) => console.error('[ToolOrchestrator] recordProcedure failed:', err));
      }
      return { success: true, answer: content, error: null, stepsCompleted, clockData, pendingConfirmation };
    }

    // Record the assistant's tool-call turn in history exactly as the API
    // returned it (needed verbatim for the follow-up 'tool' result
    // messages to be valid in the next request).
    history.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const toolName = call.function.name;
      const toolDef = TOOL_REGISTRY[toolName];
      if (!toolDef) {
        history.push(toolResultMessage(call.id, { success: false, error: `Unknown tool: ${toolName}` }));
        continue;
      }

      let args;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (err) {
        history.push(toolResultMessage(call.id, { success: false, error: 'Could not parse tool arguments as JSON.' }));
        continue;
      }

      // ---- Gate 1: permission mode ----
      const permission = getToolPermissionDecision(toolName, args, permissionMode);
      if (!permission.allowed || permission.requiresConfirmation) {
        history.push(toolResultMessage(call.id, {
          success: false,
          error: permission.reason,
          needsConfirmation: permission.requiresConfirmation,
        }));
        if (permission.requiresConfirmation && !pendingConfirmation) {
          pendingConfirmation = { toolName, args, reason: permission.reason };
        }
        continue;
      }

      // ---- Gate 1.5: pre-action confidence signal (autonomous actions only) ----
      // Fires only when the CURRENT permission mode is letting this
      // specific call skip the confirmation 'default' mode would have
      // required for it - i.e. exactly the calls where no person is
      // about to see an "Approve?" card before it runs. Detected by
      // re-checking against 'default' rather than a hardcoded tool-set,
      // so this stays correct automatically if permissionModes.js's own
      // rules ever change instead of silently drifting out of sync.
      //
      // This is the forward-looking sibling of selfReflection.js: that
      // pass reviews a draft answer after it's written; this one rates
      // confidence in an action BEFORE it runs, while there's still time
      // for the person to see it coming. See actionConfidence.js header.
      const defaultDecision = permissionMode === 'default'
        ? permission
        : getToolPermissionDecision(toolName, args, 'default');
      const isAutonomousAction = defaultDecision.allowed && defaultDecision.requiresConfirmation;
      let confidenceForSpan = null;

      if (isAutonomousAction) {
        const label = toolDef.label(args);
        const confidence = await assessActionConfidence({ userRequest, label, toolName, args })
          .catch(() => ({ confidence: 'medium', concern: 'Confidence check threw; proceeding without one.' }));
        confidenceForSpan = confidence;

        // Low confidence overrides the mode's own auto-run rule - "skips
        // confirmation" is earned per-action here, not just handed out
        // by the mode setting. A person running 'auto' still gets
        // stopped for the specific calls the model itself isn't sure
        // about; everything else keeps running exactly as fast as
        // 'auto' promised.
        if (confidence.confidence === 'low') {
          const reason = confidence.concern
            ? `Low confidence: ${confidence.concern}`
            : `ZAO wasn't confident "${label}" matches what you asked for - confirm before it runs.`;
          history.push(toolResultMessage(call.id, { success: false, error: reason, needsConfirmation: true }));
          if (!pendingConfirmation) {
            pendingConfirmation = { toolName, args, reason };
          }
          continue;
        }

        // High confidence stays quiet - narrating certainty on every
        // routine auto-run edit would bury the signal that actually
        // matters. Medium surfaces to the person BEFORE the action
        // executes (a distinct line, not folded into the post-action
        // "✓ ..." checklist item below), so an uncertain-but-not-bad-
        // enough-to-hold action is still visible in real time rather
        // than only inferable afterward from what changed.
        if (confidence.confidence === 'medium') {
          onStep?.(`⚠ ${label} - proceeding automatically, ${confidence.concern || 'though not fully certain this is the right scope'}`);
        }
      }

      // ---- Gate 2: PreToolUse hooks ----
      const preHook = await runPreToolUseHooks(toolName, args).catch(() => ({ blocked: false, reason: null }));
      if (preHook.blocked) {
        history.push(toolResultMessage(call.id, { success: false, error: preHook.reason }));
        continue;
      }

      // ---- Gate 3: telemetry span + actual execution ----
      const { spanId } = await startSpan({
        traceId, parentSpanId, sessionId, conversationId,
        name: toolName, toolName,
        attributes: confidenceForSpan
          ? { ...summarizeArgsForLog(args), preActionConfidence: confidenceForSpan.confidence, preActionConcern: confidenceForSpan.concern || null }
          : summarizeArgsForLog(args),
      });

      const result = toolName === 'agent_spawn_subagents'
        // Special-cased: this is the one tool whose implementation needs
        // the CALLER's own context/onStep (to actually run isolated
        // sub-loops and relay their live progress), not just its args -
        // see TOOL_REGISTRY's agent_spawn_subagents entry above for why
        // `run` is null there instead of a normal toolDef.run(args).
        ? await spawnSubagents(
            args.tasks,
            { githubUsername, permissionMode, sessionId, conversationId, traceId, parentSpanId: spanId },
            (description, label) => onStep?.(`[${description}] ${label}`)
          ).then((r) => ({ success: r.success, data: { results: r.results }, error: r.success ? null : { message: 'One or more subagents failed.' } }))
        : toolName === 'agent_create_worktree'
        // Special-cased for the same reason: sourceConversationId must be
        // THIS call's real conversationId (context), never a value the
        // model itself supplies - a model-supplied id would let a
        // compromised prompt fork an arbitrary conversation it has no
        // business touching.
        ? await worktreesTool.createWorktreeSessionFor({ ...args, sourceConversationId: conversationId })
        : toolName === 'reminder_create'
        // Same reasoning again: sourceConversationId must be THIS call's
        // real conversationId, not a model-supplied value. triggerAtIso is
        // parsed here (not inside reminderService) so a malformed date
        // from the model surfaces as a normal tool-result error the model
        // can see and correct, rather than reminderService silently
        // getting a NaN.
        ? await (() => {
            const parsedMs = Date.parse(args.triggerAtIso);
            if (Number.isNaN(parsedMs)) {
              return Promise.resolve({ success: false, data: null, error: { message: `"${args.triggerAtIso}" isn't a valid ISO 8601 datetime.` } });
            }
            const repeatRule = args.repeat && args.repeat !== 'none' ? args.repeat : null;
            return reminderService.scheduleReminder({ message: args.message, triggerAt: parsedMs, repeatRule, sourceConversationId: conversationId });
          })()
        : await toolDef.run(args);

      await endSpan(spanId, { status: result.success ? 'ok' : 'error', errorMessage: result.success ? null : (result.error?.message || result.error || null) });

      // ---- PostToolUse hooks (can't block - see hooksEngine.js header) ----
      runPostToolUseHooks(toolName, args, result).catch(() => {});

      history.push(toolResultMessage(call.id, result));

      if (result.success) {
        const label = toolDef.label(args);
        stepsCompleted.push(label);
        onStep?.(label);
        logUsageEvent(eventTypeForTool(toolName), label, { args: summarizeArgsForLog(args) }).catch(() => {});

        // todo_write is bookkeeping about this run's own checklist, not
        // a reusable action - excluded so a recorded procedure reflects
        // what was actually DONE, not how progress was displayed.
        if (toolName !== 'todo_write') {
          executedSteps.push({ domain: domainForTool(toolName), description: label });
        }

        if (toolName === 'time_get_current') {
          clockData = { timezone: result.data.timezone, label: result.data.resolvedLabel };
        }
      }
    }
  }

  return {
    success: false,
    answer: null,
    error: { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_TOOL_STEPS} tool calls without finishing - this task may need breaking into smaller requests.` },
    stepsCompleted,
    clockData,
    pendingConfirmation,
  };
}

/**
 * Backward-compatible wrapper matching the original GitHub-only call
 * signature (src/utils/orchestrator.js's github branch calls this name).
 * runToolTask above now handles both GitHub and Filesystem tools in one
 * pass regardless of which entry point is used - this just adapts the
 * older (userRequest, githubUsername, onStep) argument shape.
 */
export async function runGithubTask(userRequest, githubUsername, onStep = null) {
  return runToolTask(userRequest, { githubUsername }, onStep);
}

/**
 * Re-runs ONE tool call that runToolTask()'s flat loop previously refused
 * with requiresConfirmation (see pendingConfirmation above) - called only
 * from an explicit person tap on the "Approve" card ChatScreen.js renders
 * for a message carrying messages.pending_confirmation (src/db/database.js).
 * Nothing else in the app is allowed to re-invoke a confirmable call this
 * way - that's the whole point of permissionModes.js's gate (see its own
 * header + this module's Gate 1 above): a model can never talk itself into
 * running a risky/write call, only a real tap can.
 *
 * Deliberately bypasses the full tool loop (no fresh model call, no
 * history replay) - the tool name and arguments are exactly what the
 * model already asked to run; approving it re-issues that same call,
 * rather than giving the model a second chance to reconsider or rephrase
 * it.
 *
 * Covers every WRITE_TOOL/DESTRUCTIVE_TOOL/RISKY-terminal call
 * permissionModes.js can gate, not just terminal commands - see the
 * pendingConfirmation comment above for why that used to be terminal-only.
 * Terminal commands still route through their own runCommand(..., {
 * confirmed: true }) so commandSafety.js's RISKY-tier check sees the
 * explicit override; every other tool has no such per-call flag, so a
 * human tap approving the card IS the override and it's correct to just
 * re-run the tool's normal TOOL_REGISTRY.run(args) directly.
 *
 * @param {{ toolName: string, args: object }} pendingConfirmation
 * @returns {Promise<{success: boolean, data: object|null, error: object|null, label: string|null}>}
 */
export async function approveAndRunPendingTool(pendingConfirmation) {
  const { toolName, args } = pendingConfirmation || {};
  const isTerminal = TERMINAL_TOOL_NAMES_MODULE.has(toolName);
  const toolDef = TOOL_REGISTRY[toolName];

  if (!isTerminal && !toolDef) {
    return { success: false, data: null, error: { message: 'Not an approvable tool call.' }, label: null };
  }

  const label = isTerminal
    ? (toolName === 'terminal_pc_run_command' ? `Ran on PC: ${args?.command}` : `Ran on Termux: ${args?.command}`)
    : toolDef.label(args);

  const { spanId } = await startSpan({
    traceId: newTraceId(),
    name: toolName,
    toolName,
    attributes: { ...(isTerminal ? { command: args?.command } : summarizeArgsForLog(args)), confirmed: true },
  });

  const result = isTerminal
    ? await (toolName === 'terminal_pc_run_command' ? pcTerminalTool.runCommand : termuxTerminalTool.runCommand)(args.command, { confirmed: true })
    : await toolDef.run(args);

  await endSpan(spanId, { status: result.success ? 'ok' : 'error', errorMessage: result.success ? null : (result.error?.message || result.error || null) });
  logUsageEvent(isTerminal ? 'terminal_attempted' : eventTypeForTool(toolName), label, { args: isTerminal ? { command: args?.command } : summarizeArgsForLog(args), confirmed: true }).catch(() => {});

  return { ...result, label };
}

// Backward-compatible name - src/store/chatStore.js originally imported
// this terminal-specific name before approveAndRunPendingTool covered
// every confirmable tool. Kept as an alias so nothing importing the old
// name breaks; new call sites should use approveAndRunPendingTool.
export const approveAndRunTerminalCommand = approveAndRunPendingTool;

// This module builds { role, content, tool_calls, tool_call_id } messages
// directly in OpenAI's tool-calling shape. llamaEngine.js's own
// toLlamaMessage() detects already-OpenAI-shaped messages (role: 'tool',
// or an assistant message carrying tool_calls) and passes them through
// unchanged instead of mangling them, so this module's history works as-is
// with llama.rn's Jinja-templated tool-calling support (use_jinja: true).
