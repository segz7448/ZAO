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
 * This intentionally mirrors agentLoop.js's shape (a running conversation,
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
import * as terminalTool from './terminal/terminalTool';
import { logUsageEvent } from '../db/database';

const MAX_TOOL_STEPS = 20;

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

// Dispatches real shell commands to Termux via the native
// TermuxRunCommand module (see plugins/withTermuxRunCommand and
// src/services/terminal/terminalTool.js). Requires the one-time Termux
// setup (allow-external-apps + accepting Android's RUN_COMMAND
// permission prompt once) - if that hasn't happened yet, runCommand()
// returns a clear error with the exact setup command rather than
// silently doing nothing or claiming success.
const TERMINAL_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'terminal_run_command',
      description: 'Runs a real shell command in Termux (npm install, pip install, gradlew, unzip, compile, etc.) and returns its actual stdout/stderr/exit code. Requires Termux to be installed with the one-time RUN_COMMAND permission granted - if not yet granted, this returns an error with the exact setup command to give the person instead of pretending the command ran.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

// Maps schema function names to the real githubTool.js implementation and
// a short human-readable label for the chat checklist (e.g. "Created
// repository", not the raw function name). Adding a new tool later
// (filesystem, terminal, pdf, office) means adding its schemas + this kind
// of registry entry, not changing the loop below.
const TOOL_REGISTRY = {
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
  terminal_run_command: {
    run: (args) => terminalTool.runCommand(args.command),
    label: (args) => `Ran: ${args.command}`,
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
    pdf_create: 'file_created',
    pdf_merge: 'file_created',
    pdf_split: 'file_created',
    docx_create: 'file_created',
    xlsx_create: 'file_created',
    csv_create: 'file_created',
    pptx_create: 'file_created',
    terminal_run_command: 'terminal_attempted',
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
  for (const key of ['path', 'outputPath', 'name', 'owner', 'repo', 'sourcePath', 'destinationFolder', 'folderPath']) {
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
 * @param {string} userRequest - the person's message, e.g. "create an Expo app and push it to GitHub"
 * @param {object} context - { githubUsername } - passed straight into the system prompt as a hint so the model doesn't have to ask "whose account?" for every request
 * @param {function} onStep - optional callback(label) fired each time a tool call completes, for the chat's live "✓ ..." checklist
 * @returns {Promise<{success: boolean, answer: string|null, error: object|null, stepsCompleted: string[]}>}
 */
export async function runToolTask(userRequest, context = {}, onStep = null) {
  const { githubUsername = null } = context;

  const systemPrompt = `You are ZAO's project manager. The person describes what they want in plain language; you decide which tool functions to call, in what order, to accomplish it - they should never need to name a specific function or press a button themselves.

You have four kinds of tools available: GitHub (repos, commits, branches, PRs, releases), Filesystem (creating/moving/renaming/deleting/zipping files directly on the person's device), PDF (create/merge/split), and Office (docx_create for Word documents, xlsx_create/csv_create for spreadsheets, pptx_create for presentations) - write the actual document/spreadsheet/slide content yourself, each tool just turns it into a real file. Use whichever combination the request actually needs.

A fifth tool, terminal_run_command, exists in your tool list but is NOT currently functional (a real Android capability it needs isn't available in this build yet) - if a request genuinely needs to run a shell command (npm install, pip install, compiling something, etc.), tell the person clearly that this isn't available yet rather than calling the tool and reporting success, or trying to work around it with the other tools.

${githubUsername ? `Their GitHub username is "${githubUsername}" - use this as the owner for new repos unless they specify an organization instead.` : 'No GitHub username is on file yet - ask for it if a GitHub action needs an owner and none is given in the request.'}

When generating file content (for fs_create_file or github_commit_files), write complete, working file content - not placeholders or "TODO" stubs. Once everything requested is actually done, give a short, plain-language summary of what was created/changed - don't just say "done", name what happened.`;

  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userRequest },
  ];

  const stepsCompleted = [];
  const allSchemas = [...GITHUB_TOOL_SCHEMAS, ...FILESYSTEM_TOOL_SCHEMAS, ...PDF_TOOL_SCHEMAS, ...OFFICE_TOOL_SCHEMAS, ...TERMINAL_TOOL_SCHEMAS];

  for (let i = 0; i < MAX_TOOL_STEPS; i++) {
    const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      tools: allSchemas,
      maxTokens: 2048,
      temperature: 0.3,
    });

    if (!modelResult.success) {
      return { success: false, answer: null, error: modelResult.error, stepsCompleted };
    }

    const { content, toolCalls } = modelResult.data;

    if (!toolCalls) {
      // No more tool calls - this is the model's final answer.
      return { success: true, answer: content, error: null, stepsCompleted };
    }

    // Record the assistant's tool-call turn in history exactly as the API
    // returned it (needed verbatim for the follow-up 'tool' result
    // messages to be valid in the next request).
    history.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const toolDef = TOOL_REGISTRY[call.function.name];
      if (!toolDef) {
        history.push(toolResultMessage(call.id, { success: false, error: `Unknown tool: ${call.function.name}` }));
        continue;
      }

      let args;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (err) {
        history.push(toolResultMessage(call.id, { success: false, error: 'Could not parse tool arguments as JSON.' }));
        continue;
      }

      const result = await toolDef.run(args);
      history.push(toolResultMessage(call.id, result));

      if (result.success) {
        const label = toolDef.label(args);
        stepsCompleted.push(label);
        onStep?.(label);
        logUsageEvent(eventTypeForTool(call.function.name), label, { args: summarizeArgsForLog(args) }).catch(() => {});
      }
    }
  }

  return {
    success: false,
    answer: null,
    error: { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_TOOL_STEPS} tool calls without finishing - this task may need breaking into smaller requests.` },
    stepsCompleted,
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

// This module builds { role, content, tool_calls, tool_call_id } messages
// directly in OpenAI's tool-calling shape. llamaEngine.js's own
// toLlamaMessage() detects already-OpenAI-shaped messages (role: 'tool',
// or an assistant message carrying tool_calls) and passes them through
// unchanged instead of mangling them, so this module's history works as-is
// with llama.rn's Jinja-templated tool-calling support (use_jinja: true).
